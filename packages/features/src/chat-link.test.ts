import { z } from "zod";
import { AppError, ConnectionSchema, decodeBase64, encodeBase64, type Settings } from "@veil/core";
import {
  SYNC_FORMAT,
  SYNC_KINDS,
  SYNC_VERSION,
  signPayload,
  verifySignature,
  type SyncEnvelope,
} from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { applyInboundChatEnvelope, listChatThread, type ChatDeps } from "./chat";
import { isValidFeedUrl } from "./feed";
import { loadOrCreateShareIdentity } from "./sharing";
import { addNote, listConnections, loadSettings } from "./social";
import { fromBase64Url, toBase64Url } from "./share-link";

// decodeBase64 (inside fromBase64Url) is strict about padding, and link encoding strips it.
// Re-pad here so chat and connect links decode today; PR #41 moves the same fix into
// fromBase64Url itself, after which this is a harmless no-op on already-padded input.
const fromPaddedBase64Url = (encoded: string): string =>
  fromBase64Url(encoded + "=".repeat((4 - (encoded.length % 4)) % 4));

/**
 * Chat and connect links: a textable URL that opens eic straight into a conversation, so a
 * friend never handles a JSON file. Everything travels in the URL fragment (after '#'), which
 * browsers never put into an HTTP request - the ciphertext and the card reach neither the
 * static host nor any link-preview unfurler. Same 8000-char cap as post links, so the URL
 * stays usable in chat apps and SMS. A link is hand delivery, not a transport: automatic
 * chat still rides the pull-sync feed.
 */
export const CHAT_LINK_PREFIX = "#chat=";
export const CONNECT_LINK_PREFIX = "#connect=";
export const MAX_CHAT_LINK_CHARS = 8000;
const MAX_LINK_ENVELOPES = 20;
const CONNECT_FORMAT = "eic-connect";
const CONNECT_VERSION = 1;

const idField = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const SyncEnvelopeSchema = z.object({
  format: z.literal(SYNC_FORMAT),
  version: z.literal(SYNC_VERSION),
  authorId: idField,
  recipientAuthorId: idField,
  kind: z.enum(SYNC_KINDS),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  signature: z.string().min(1),
});

const ChatLinkSchema = z.object({
  v: z.literal(1),
  from: z.object({ id: idField, handle: z.string().min(1).max(30) }),
  envelopes: z.array(SyncEnvelopeSchema).min(1).max(MAX_LINK_ENVELOPES),
});
export type ChatLink = z.infer<typeof ChatLinkSchema>;

const ConnectCardSchema = z.object({
  format: z.literal(CONNECT_FORMAT),
  version: z.literal(CONNECT_VERSION),
  exportedAt: z.iso.datetime(),
  author: z.object({
    id: idField,
    handle: z.string().min(1).max(30),
    pubkey: z.string().min(1),
    feedUrl: z.string().min(1).optional(),
  }),
  signature: z.string().min(1),
});
export type ConnectCard = z.infer<typeof ConnectCardSchema>;

function chatLinkText(authorId: string, handle: string, envelopes: SyncEnvelope[]): string {
  return JSON.stringify({ v: 1, from: { id: authorId, handle }, envelopes });
}

function chatLink(authorId: string, handle: string, envelopes: SyncEnvelope[], baseUrl: string): string {
  return `${baseUrl}${CHAT_LINK_PREFIX}${toBase64Url(chatLinkText(authorId, handle, envelopes))}`;
}

/**
 * Builds a link carrying my most recent sealed chat envelopes for this connection, newest
 * first, as many as fit under the cap. The envelopes were sealed to the connection's key at
 * send time, so only their vault can open them; anyone else holding the link sees ciphertext.
 * `before` is a stable cursor: the id of the oldest message the previous link carried, so the
 * next link carries strictly older messages. A cursor stays correct when new messages arrive
 * between batches - no duplicates, no silently skipped message.
 */
export async function buildChatShareLink(
  vault: UnlockedVault,
  connection: { id: string; pubkey: string | null },
  baseUrl: string,
  opts: { before?: string } = {},
): Promise<{ link: string; messageCount: number; leftOut: number; oldestCarriedId: string | null }> {
  if (!connection.pubkey) {
    throw new AppError("Chat links need a verified connection. Re-import their signed share file first.");
  }
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle) {
    throw new AppError("Save a handle before sharing a chat link.");
  }
  const all = (await listChatThread(vault, connection.id)).filter(
    (message) => message.direction === "out" && message.envelope !== null,
  );
  let outbound = all;
  if (opts.before) {
    const marker = all.findIndex((message) => message.id === opts.before);
    if (marker === -1) {
      throw new AppError("That older-batch marker is stale. Start again from the latest messages.");
    }
    outbound = all.slice(0, marker);
  }
  if (outbound.length === 0) {
    throw new AppError(
      all.length === 0
        ? "Write a message first - a chat link carries messages you have already sent."
        : "No older messages left to carry.",
    );
  }
  const picked: { id: string; envelope: SyncEnvelope }[] = [];
  for (const message of [...outbound].reverse()) {
    picked.unshift({ id: message.id, envelope: message.envelope as SyncEnvelope });
    const over =
      picked.length > MAX_LINK_ENVELOPES ||
      chatLink(settings.authorId, settings.handle, picked.map((m) => m.envelope), baseUrl).length > MAX_CHAT_LINK_CHARS;
    if (over) {
      picked.shift();
      break;
    }
  }
  if (picked.length === 0) {
    throw new AppError("Your latest message is too big for a link. Try a shorter one.");
  }
  return {
    link: chatLink(settings.authorId, settings.handle, picked.map((m) => m.envelope), baseUrl),
    messageCount: picked.length,
    leftOut: outbound.length - picked.length,
    oldestCarriedId: picked[0].id,
  };
}

/**
 * Reads a chat link fragment. Returns null when the hash is not a chat link; throws AppError
 * when it looks like one but does not decode and validate.
 */
export function readChatShareLink(hash: string): ChatLink | null {
  if (!hash.startsWith(CHAT_LINK_PREFIX)) return null;
  if (hash.length > MAX_CHAT_LINK_CHARS) throw new AppError("That chat link is too long to be real.");
  try {
    return ChatLinkSchema.parse(JSON.parse(fromPaddedBase64Url(hash.slice(CHAT_LINK_PREFIX.length))));
  } catch {
    throw new AppError("That chat link is damaged. Ask your friend for a fresh one.");
  }
}

/**
 * Applies a chat link's envelopes to this vault (idempotent - a re-tap applies nothing new)
 * and reports whose chat to open. Envelopes must come from the link's stated sender, who must
 * already be a verified connection: the link's own `from` card is display text, never a key
 * source, so a forwarded or edited link cannot inject a stranger's key.
 */
export async function applyChatShareLink(
  vault: UnlockedVault,
  link: ChatLink,
  deps: ChatDeps,
): Promise<{ authorId: string; handle: string; applied: number; failed: number; total: number }> {
  const sender = (await listConnections(vault)).find((candidate) => candidate.id === link.from.id);
  if (!sender) {
    throw new AppError(
      `This chat link is from @${link.from.handle}, who is not a connection yet. Ask them for a connect link first - once you connect, this link opens the chat on its own.`,
    );
  }
  if (!sender.pubkey) {
    throw new AppError(
      `Your connection with @${sender.handle} has no verified key. Re-import their signed share file, then open the link again.`,
    );
  }
  // Structural mismatches reject the whole link; a per-envelope crypto failure is reported
  // honestly instead of mislabeling the link damaged - anything already applied stays applied.
  let applied = 0;
  let failed = 0;
  for (const envelope of link.envelopes) {
    if (envelope.authorId !== sender.id || envelope.kind !== "chat") {
      throw new AppError("That chat link is damaged. Ask your friend for a fresh one.");
    }
    try {
      const result = await applyInboundChatEnvelope(vault, envelope, deps);
      if (result.applied) applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { authorId: sender.id, handle: sender.handle, applied, failed, total: link.envelopes.length };
}

/**
 * Builds a connect link: my signed card (handle + Ed25519 key + optional feed URL) and nothing
 * else. No posts, no likes, no secrets. The signature proves the card is self-consistent and
 * untouched; the trust anchor is the channel it arrives through, exactly like a share file.
 */
export async function buildConnectLink(vault: UnlockedVault, baseUrl: string, now: Date): Promise<string> {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle) {
    throw new AppError("Save a handle before sharing a connect link.");
  }
  const identity = await loadOrCreateShareIdentity(vault);
  const unsigned = {
    format: CONNECT_FORMAT,
    version: CONNECT_VERSION,
    exportedAt: now.toISOString(),
    author: {
      id: settings.authorId,
      handle: settings.handle,
      pubkey: encodeBase64(identity.publicKey),
      ...(settings.feedUrl ? { feedUrl: settings.feedUrl } : {}),
    },
  } as const;
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const link = `${baseUrl}${CONNECT_LINK_PREFIX}${toBase64Url(
    JSON.stringify({ ...unsigned, signature: encodeBase64(signature) }),
  )}`;
  if (link.length > MAX_CHAT_LINK_CHARS) {
    throw new AppError("That connect link is too long.");
  }
  return link;
}

/** Reads a connect link fragment to its raw card text, or null when the hash is not one. */
export function readConnectLink(hash: string): string | null {
  if (!hash.startsWith(CONNECT_LINK_PREFIX)) return null;
  if (hash.length > MAX_CHAT_LINK_CHARS) throw new AppError("That connect link is too long to be real.");
  try {
    return fromPaddedBase64Url(hash.slice(CONNECT_LINK_PREFIX.length));
  } catch {
    throw new AppError("That connect link is damaged. Ask your friend for a fresh one.");
  }
}

/** Best-effort handle for the confirm dialog; the real validation happens in importConnectCard. */
export function peekConnectCardHandle(text: string): string | null {
  try {
    const parsed = ConnectCardSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.author.handle : null;
  } catch {
    return null;
  }
}

/**
 * Imports a connect card: verifies the Ed25519 signature against the card's own key, then adds
 * or refreshes the connection. Unlike a share-file re-import, a connect card never resets
 * pull-sync cursors - it is not the recovery path. Nickname and hidden survive a re-import.
 */
export async function importConnectCard(
  vault: UnlockedVault,
  text: string,
  deps: { settings: Settings; newId: () => string; now: Date },
): Promise<{ authorId: string; handle: string; isNew: boolean }> {
  if (new TextEncoder().encode(text).byteLength > MAX_CHAT_LINK_CHARS) {
    throw new AppError("That connect link is too large.");
  }
  let card: ConnectCard;
  try {
    card = ConnectCardSchema.parse(JSON.parse(text));
  } catch {
    throw new AppError("That connect link is not a connect card, or it is from a newer version.");
  }
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildShareBundle, importShareBundle } from "./sharing";
import { defaultSettings, listConnections, saveSettings, type Settings } from "./social";
import { listChatThread, sendChatMessage, type ChatDeps } from "./chat";
import {
  CHAT_LINK_PREFIX,
  CONNECT_LINK_PREFIX,
  MAX_CHAT_LINK_CHARS,
  applyChatShareLink,
  buildChatShareLink,
  buildConnectLink,
  importConnectCard,
  peekConnectCardHandle,
  readChatShareLink,
  readConnectLink,
} from "./chat-link";

const NOW = new Date("2026-10-31T12:00:00Z");
const BASE = "https://everybodyiscool.netlify.app/";
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const deps: ChatDeps = { newId: () => `m${counter++}`, now: () => NOW };
const importDeps = (settings: Settings) => ({ settings, newId: deps.newId, now: NOW });

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, importDeps(settingsFor("bob-id", "bob")));
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, importDeps(settingsFor("alice-id", "alice")));
  return { alice, bob };
}

const connectionFor = async (vault: UnlockedVault, authorId: string) =>
  (await listConnections(vault)).find((c) => c.id === authorId)!;

describe("chat links", () => {
  it("round-trips sealed messages through a fragment link without exposing plaintext", async () => {
    const { alice, bob } = await pairedVaults();
    const bobConn = await connectionFor(bob, "alice-id");
    await sendChatMessage(bob, bobConn, "first hello", deps);
    await sendChatMessage(bob, bobConn, "second hello 📡", deps);

    const { link, messageCount, leftOut } = await buildChatShareLink(bob, bobConn, BASE);
    expect(messageCount).toBe(2);
    expect(leftOut).toBe(0);
    expect(link.startsWith(`${BASE}${CHAT_LINK_PREFIX}`)).toBe(true);
    expect(link.length).toBeLessThanOrEqual(MAX_CHAT_LINK_CHARS);
    expect(link).not.toContain("hello");

    const parsed = readChatShareLink(new URL(link).hash);
    expect(parsed!.from).toEqual({ id: "bob-id", handle: "bob" });
    const result = await applyChatShareLink(alice, parsed!, deps);
    expect(result).toMatchObject({ authorId: "bob-id", handle: "bob", applied: 2, total: 2 });
    expect((await listChatThread(alice, "bob-id")).map((m) => m.body)).toEqual(["first hello", "second hello 📡"]);
  });

  it("is idempotent: tapping the same link twice applies nothing new but still opens the chat", async () => {
    const { alice, bob } = await pairedVaults();
    await sendChatMessage(bob, await connectionFor(bob, "alice-id"), "hi again", deps);
    const { link } = await buildChatShareLink(bob, await connectionFor(bob, "alice-id"), BASE);
    const parsed = readChatShareLink(new URL(link).hash)!;
    expect((await applyChatShareLink(alice, parsed, deps)).applied).toBe(1);
    const second = await applyChatShareLink(alice, parsed, deps);
    expect(second.applied).toBe(0);
    expect((await listChatThread(alice, "bob-id"))).toHaveLength(1);
  });

  it("keeps only the newest messages that fit under the link cap", async () => {
    const { bob } = await pairedVaults();
    const conn = await connectionFor(bob, "alice-id");
    for (let i = 0; i < 8; i++) {
      await sendChatMessage(bob, conn, `message ${i} ${"x".repeat(1800)}`, deps);
    }
    const { link, messageCount, leftOut } = await buildChatShareLink(bob, conn, BASE);
    expect(link.length).toBeLessThanOrEqual(MAX_CHAT_LINK_CHARS);
    expect(messageCount).toBeGreaterThanOrEqual(1);
    expect(messageCount).toBeLessThan(8);
    // Honesty: what did not fit is reported, never silently dropped.
    expect(leftOut).toBe(8 - messageCount);
    const parsed = readChatShareLink(new URL(link).hash)!;
    // The newest message is always the last envelope.
    expect(parsed.envelopes.at(-1)!.ciphertext).toBeTruthy();
  });

  it("carries older batches by cursor: no dup, no loss, stable when new messages arrive", async () => {
    const { bob } = await pairedVaults();
    const conn = await connectionFor(bob, "alice-id");
    for (let i = 0; i < 8; i++) {
      await sendChatMessage(bob, conn, `message ${i} ${"x".repeat(1800)}`, deps);
    }
    const first = await buildChatShareLink(bob, conn, BASE);
    expect(first.leftOut).toBeGreaterThan(0);
    expect(first.oldestCarriedId).toBeTruthy();

    // A new message arrives between batches: the cursor must still bound batch two exactly.
    await sendChatMessage(bob, conn, "fresh arrival", deps);
    const second = await buildChatShareLink(bob, conn, BASE, { before: first.oldestCarriedId! });
    expect(second.messageCount).toBeGreaterThanOrEqual(1);
    expect(second.leftOut).toBe(first.leftOut - second.messageCount);

    // Dedupe: no envelope appears in both links, and batch two is strictly older.
    const firstParsed = readChatShareLink(new URL(first.link).hash)!;
    const secondParsed = readChatShareLink(new URL(second.link).hash)!;
    const firstCts = new Set(firstParsed.envelopes.map((e) => e.ciphertext));
    expect(secondParsed.envelopes.every((e) => !firstCts.has(e.ciphertext))).toBe(true);

    // No infinite omit: walking cursors to the end covers everything and reports the end.
    let cursor = second.oldestCarriedId!;
    let left = second.leftOut;
    let carried = first.messageCount + second.messageCount;
    while (left > 0) {
      const next = await buildChatShareLink(bob, conn, BASE, { before: cursor });
      carried += next.messageCount;
      left = next.leftOut;
      cursor = next.oldestCarriedId!;
    }
    expect(carried).toBe(8);
    await expect(buildChatShareLink(bob, conn, BASE, { before: cursor })).rejects.toThrow(/No older messages left/);
    // A stale cursor says so instead of guessing.
    await expect(buildChatShareLink(bob, conn, BASE, { before: "no-such-message" })).rejects.toThrow(/stale/);
  });

  it("rejects a chat link when there is nothing sent yet", async () => {
    const { bob } = await pairedVaults();
    await expect(buildChatShareLink(bob, await connectionFor(bob, "alice-id"), BASE)).rejects.toThrow(/Write a message first/);
  });

  it("refuses to apply a link from someone who is not a connection", async () => {
    const { bob } = await pairedVaults();
    const stranger = await open();
    await saveSettings(stranger, settingsFor("stranger-id", "stranger"));
    await sendChatMessage(bob, await connectionFor(bob, "alice-id"), "for alice only", deps);
    const { link } = await buildChatShareLink(bob, await connectionFor(bob, "alice-id"), BASE);
    const parsed = readChatShareLink(new URL(link).hash)!;
    await expect(applyChatShareLink(stranger, parsed, deps)).rejects.toThrow(/not a connection yet/);
  });

  it("rejects damaged chat links and non-chat hashes", async () => {
    expect(readChatShareLink("")).toBeNull();
    expect(readChatShareLink("#/feed")).toBeNull();
    expect(readChatShareLink("#import=abc")).toBeNull();
    expect(() => readChatShareLink(`${CHAT_LINK_PREFIX}!!!nope!!!`)).toThrow(/damaged/);
    expect(() => readChatShareLink(`${CHAT_LINK_PREFIX}${Buffer.from('{"v":2}').toString("base64")}`)).toThrow(/damaged/);
  });

  it("caps fragment size before decoding anything", async () => {
    expect(() => readChatShareLink(`${CHAT_LINK_PREFIX}${"A".repeat(MAX_CHAT_LINK_CHARS)}`)).toThrow(/too long/);
    expect(() => readConnectLink(`${CONNECT_LINK_PREFIX}${"A".repeat(MAX_CHAT_LINK_CHARS)}`)).toThrow(/too long/);
  });

  it("reports per-envelope failures honestly instead of calling the link damaged", async () => {
    const { alice, bob } = await pairedVaults();
    const conn = await connectionFor(bob, "alice-id");
    await sendChatMessage(bob, conn, "one", deps);
    await sendChatMessage(bob, conn, "two", deps);
    const { link } = await buildChatShareLink(bob, conn, BASE);
    const parsed = readChatShareLink(new URL(link).hash)!;
    // Corrupt the second envelope's ciphertext: a crypto failure, not a structural one.
    const envelopes = parsed.envelopes.map((e, i) => (i === 1 ? { ...e, ciphertext: `A${e.ciphertext.slice(1)}` } : e));
    const result = await applyChatShareLink(alice, { ...parsed, envelopes }, deps);
    expect(result).toMatchObject({ applied: 1, failed: 1, total: 2 });
    expect((await listChatThread(alice, "bob-id")).map((m) => m.body)).toEqual(["one"]);
  });
});

describe("connect links", () => {
  it("round-trips a signed card that creates a verified connection", async () => {
    const { alice, bob } = await pairedVaults();
    const link = await buildConnectLink(bob, BASE, NOW);
    expect(link.startsWith(`${BASE}${CONNECT_LINK_PREFIX}`)).toBe(true);
    const text = readConnectLink(new URL(link).hash)!;
    expect(peekConnectCardHandle(text)).toBe("bob");

    // Carol has never seen bob: the card alone creates the connection with his verified key.
    const carol = await open();
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    const result = await importConnectCard(carol, text, importDeps(settingsFor("carol-id", "carol")));
    expect(result).toEqual({ authorId: "bob-id", handle: "bob", isNew: true });
    const conn = await connectionFor(carol, "bob-id");
    expect(conn.pubkey).toBeTruthy();

    // And a chat sealed to carol's key... goes the other way: bob can now open carol's card.
    const aliceLink = await buildConnectLink(alice, BASE, NOW);
    expect(peekConnectCardHandle(readConnectLink(new URL(aliceLink).hash)!)).toBe("alice");
  });

  it("verifies the signature: a tampered card is rejected", async () => {
    const { bob } = await pairedVaults();
    const text = readConnectLink(new URL(await buildConnectLink(bob, BASE, NOW)).hash)!;
    const card = JSON.parse(text);
    card.author.handle = "mallory";
    const carol = await open();
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    await expect(importConnectCard(carol, JSON.stringify(card), importDeps(settingsFor("carol-id", "carol")))).rejects.toThrow(/signature does not check out/);
    expect(await listConnections(carol)).toHaveLength(0);
  });

  it("rejects your own card and keeps nickname and sync state on re-import", async () => {
    const { alice, bob } = await pairedVaults();
    const bobText = readConnectLink(new URL(await buildConnectLink(bob, BASE, NOW)).hash)!;
    await expect(importConnectCard(bob, bobText, importDeps(settingsFor("bob-id", "bob")))).rejects.toThrow(/your own connect link/);

    // Alice already knows bob with a nickname and sync progress; the card refreshes, never resets.
    const before = await connectionFor(alice, "bob-id");
    const result = await importConnectCard(alice, bobText, importDeps(settingsFor("alice-id", "alice")));
    expect(result.isNew).toBe(false);
    const after = await connectionFor(alice, "bob-id");
    expect(after.nickname).toBe(before.nickname);
    expect(after.syncSeq).toBe(before.syncSeq);
    expect(after.pubkey).toBe(before.pubkey);
  });

  it("refuses to silently replace a verified key with a different one", async () => {
    const { bob } = await pairedVaults();
    const carol = await open();
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    const text = readConnectLink(new URL(await buildConnectLink(bob, BASE, NOW)).hash)!;
    await importConnectCard(carol, text, importDeps(settingsFor("carol-id", "carol")));

    // A second "bob" with the same id and handle but a fresh key must not rotate the old one.
    const bob2 = await open();
    await saveSettings(bob2, settingsFor("bob-id", "bob"));
    const text2 = readConnectLink(new URL(await buildConnectLink(bob2, BASE, NOW)).hash)!;
    await expect(importConnectCard(carol, text2, importDeps(settingsFor("carol-id", "carol")))).rejects.toThrow(/different key/);
    expect((await connectionFor(carol, "bob-id")).pubkey).toBe(JSON.parse(text).author.pubkey);
  });

  it("refreshes a connection when the key matches, and upgrades a keyless one", async () => {
    const { bob } = await pairedVaults();
    const carol = await open();
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    const text = readConnectLink(new URL(await buildConnectLink(bob, BASE, NOW)).hash)!;
    await importConnectCard(carol, text, importDeps(settingsFor("carol-id", "carol")));
    // Same card again: fine, key unchanged.
    const again = await importConnectCard(carol, text, importDeps(settingsFor("carol-id", "carol")));
    expect(again.isNew).toBe(false);
  });

  it("rejects damaged connect links", async () => {
    expect(readConnectLink("")).toBeNull();
    expect(readConnectLink("#chat=abc")).toBeNull();
    expect(() => readConnectLink(`${CONNECT_LINK_PREFIX}!!!nope!!!`)).toThrow(/damaged/);
  });
});
