import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { AppError } from "@veil/core";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildShareBundle, importShareBundle } from "./sharing";
import { defaultSettings, listConnections, saveSettings, type Settings } from "./social";
import {
  applyInboundChatEnvelope,
  listChatThread,
  markThreadRead,
  sendChatMessage,
  unreadCounts,
  type ChatDeps,
  describeSendError,
} from "./chat";

const NOW = new Date("2026-10-30T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const deps: ChatDeps = { newId: () => `m${counter++}`, now: () => NOW };

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  // Each imports the other's signed share bundle, so both hold a verified connection.
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
  return { alice, bob };
}

describe("chat over pull", () => {
  it("sending stores the message locally with a sealed envelope - no plaintext on the wire", async () => {
    const { bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const message = await sendChatMessage(bob, aliceConn, "hello alice 📡", deps);
    expect(message.direction).toBe("out");
    expect(message.threadAuthorId).toBe("alice-id");
    expect(JSON.stringify(message.envelope)).not.toContain("hello alice");
    const thread = await listChatThread(bob, "alice-id");
    expect(thread.map((m) => m.body)).toEqual(["hello alice 📡"]);
  });

  it("the recipient applies the envelope once - re-pulls are idempotent", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "from bob", deps);
    const first = await applyInboundChatEnvelope(alice, sent.envelope, deps);
    expect(first.applied).toBe(true);
    expect(first.message!.body).toBe("from bob");
    expect(first.message!.direction).toBe("in");
    const again = await applyInboundChatEnvelope(alice, sent.envelope, deps);
    expect(again.applied).toBe(false);
    expect((await listChatThread(alice, "bob-id"))).toHaveLength(1);
  });

  it("rejects envelopes from unknown connections and tampered envelopes", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "from bob", deps);
    const fresh = await open();
    await saveSettings(fresh, settingsFor("fresh-id", "fresh"));
    await expect(applyInboundChatEnvelope(fresh, sent.envelope, deps)).rejects.toThrow("unknown connection");
    const tampered = { ...(sent.envelope as object), ciphertext: "AAAA" };
    await expect(applyInboundChatEnvelope(alice, tampered, deps)).rejects.toThrow();
  });

  it("refuses to send to an unverified (unsigned bundle) connection", async () => {
    const { bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    await expect(sendChatMessage(bob, { ...aliceConn, pubkey: null }, "hi", deps)).rejects.toThrow("unsigned");
  });

  it("tracks unread counts per thread and marks a thread read", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    await sendChatMessage(bob, aliceConn, "one", deps);
    await sendChatMessage(bob, aliceConn, "two", deps);
    for (const m of await listChatThread(bob, "alice-id")) {
      await applyInboundChatEnvelope(alice, m.envelope, deps);
    }
    expect(await unreadCounts(alice)).toEqual({ "bob-id": 2 });
    expect(await markThreadRead(alice, "bob-id", new Date("2026-10-30T13:00:00Z"))).toBe(2);
    expect(await unreadCounts(alice)).toEqual({});
    const thread = await listChatThread(alice, "bob-id");
    expect(thread.map((m) => m.body)).toEqual(["one", "two"]);
    expect(thread.every((m) => m.readAt !== null)).toBe(true);
  });
});

describe("describeSendError", () => {
  it("passes user-written AppError messages through unchanged", () => {
    expect(describeSendError(new AppError("Chat needs a verified connection."))).toBe("Chat needs a verified connection.");
  });

  it("gives a generic honest message for unexpected failures (crypto, IndexedDB, etc.)", () => {
    expect(describeSendError(new TypeError("crypto.subtle is undefined"))).toBe(
      "That did not send. Your message is still in the box - please try again.",
    );
    expect(describeSendError("weird non-error")).toBe("That did not send. Your message is still in the box - please try again.");
  });
});
