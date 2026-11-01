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

/** Best-effort card author for the confirm dialog; the real validation happens in importConnectCard. */
export function peekConnectCardAuthor(text: string): { id: string; handle: string } | null {
  try {
    const parsed = ConnectCardSchema.safeParse(JSON.parse(text));
    return parsed.success ? { id: parsed.data.author.id, handle: parsed.data.author.handle } : null;
  } catch {
    return null;
  }
}

/** Best-effort handle for the confirm dialog; the real validation happens in importConnectCard. */
export function peekConnectCardHandle(text: string): string | null {
  return peekConnectCardAuthor(text)?.handle ?? null;
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
  let verified = false;
  try {
    const { signature, ...unsigned } = card;
    verified = await verifySignature(
      decodeBase64(card.author.pubkey),
      new TextEncoder().encode(JSON.stringify(unsigned)),
      decodeBase64(signature),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AppError("That connect link's signature does not check out. Ask your friend for a fresh one.");
  }
  if (!deps.settings.authorId) throw new AppError("Choose a handle before connecting.");
  const { author } = card;
  if (author.id === deps.settings.authorId) throw new AppError("That is your own connect link.");
  const connectionId = `connection:${author.id}`;
  const prior = ConnectionSchema.safeParse(await vault.getJson(connectionId));
  const keep = prior.success ? prior.data : null;
  if (keep && keep.pubkey && keep.pubkey !== author.pubkey) {
    throw new AppError(
      `@${keep.handle} already connected with a different key, so this link was not applied and your trusted key is unchanged. Only replace it if they told you they rebuilt their vault - and then by re-importing their new signed share file from the Connections screen, where the key change asks for your explicit okay. A link alone never replaces a key.`,
    );
  }
  await vault.putJson("connection", connectionId, {
    id: author.id,
    handle: author.handle,
    addedAt: keep ? keep.addedAt : deps.now.toISOString(),
    nickname: keep ? keep.nickname : null,
    hidden: keep ? keep.hidden : false,
    lastImportAt: deps.now.toISOString(),
    pubkey: author.pubkey,
    feedUrl:
      author.feedUrl && isValidFeedUrl(author.feedUrl) ? author.feedUrl : keep ? keep.feedUrl : null,
    syncSeq: keep ? keep.syncSeq : 0,
    syncEtag: keep ? keep.syncEtag : null,
    syncPending: keep ? keep.syncPending : false,
    syncRetry: keep ? keep.syncRetry : 0,
    syncExhausted: keep ? keep.syncExhausted : false,
    syncStatus: keep ? keep.syncStatus : "",
    syncDetail: keep ? keep.syncDetail : "",
    schemaVersion: 1,
  });
  await addNote(vault, `Connected with @${author.handle} from a link.`, deps);
  return { authorId: author.id, handle: author.handle, isNew: keep === null };
}
