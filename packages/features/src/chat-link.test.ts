import { describe, expect, it } from "vitest";
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

    const { link, messageCount } = await buildChatShareLink(bob, bobConn, BASE);
    expect(messageCount).toBe(2);
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
    const { link, messageCount } = await buildChatShareLink(bob, conn, BASE);
    expect(link.length).toBeLessThanOrEqual(MAX_CHAT_LINK_CHARS);
    expect(messageCount).toBeGreaterThanOrEqual(1);
    expect(messageCount).toBeLessThan(8);
    const parsed = readChatShareLink(new URL(link).hash)!;
    // The newest message is always the last envelope.
    expect(parsed.envelopes.at(-1)!.ciphertext).toBeTruthy();
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

  it("rejects damaged connect links", async () => {
    expect(readConnectLink("")).toBeNull();
    expect(readConnectLink("#chat=abc")).toBeNull();
    expect(() => readConnectLink(`${CONNECT_LINK_PREFIX}!!!nope!!!`)).toThrow(/damaged/);
  });
});
