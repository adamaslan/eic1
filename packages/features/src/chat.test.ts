import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { AppError } from "@veil/core";
import { createVault, unlockVault, type UnlockedVault } from "@veil/vault";
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

  it("two tabs applying the same envelope concurrently store ONE message (deterministic id)", async () => {
    // Two unlocked instances over one store = two browser tabs on the same vault. Both
    // can pass the seen-before scan before either writes (manual Check in one tab racing
    // the auto catch-up in the other); the signature-derived record id must collapse the
    // race into a single record instead of a duplicate under a fresh id.
    const store = new MemoryStore();
    const crypto = new SubtleCryptoPort();
    const alice = await createVault({ store, crypto, now: () => NOW }, "pass phrase 1");
    const bob = await open();
    await saveSettings(alice, settingsFor("alice-id", "alice"));
    await saveSettings(bob, settingsFor("bob-id", "bob"));
    await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
    await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "race me", deps);
    const tab2 = await unlockVault({ store, crypto, now: () => NOW }, "pass phrase 1");
    const [one, two] = await Promise.all([
      applyInboundChatEnvelope(alice, sent.envelope, deps),
      applyInboundChatEnvelope(tab2, sent.envelope, deps),
    ]);
    const thread = await listChatThread(alice, "bob-id");
    expect(thread).toHaveLength(1);
    expect(thread[0]!.body).toBe("race me");
    expect(one.message!.id).toBe(two.message!.id);
    // The stored record still answers to the scan-based fast path afterwards.
    const later = await applyInboundChatEnvelope(tab2, sent.envelope, deps);
    expect(later.applied).toBe(false);
    // markThreadRead addresses records by recordIdFor(message.id) - it must hit the row.
    expect(await markThreadRead(alice, "bob-id", NOW)).toBe(1);
    expect((await unreadCounts(alice))["bob-id"]).toBeUndefined();
  });

  it("a receiver that loses the write race keeps the winner's record - and its readAt", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "race read state", deps);
    // Interleave: between receiver A's absent scan and its atomic write, receiver B
    // stores the same deterministic record and the user marks the thread read. A's
    // insert-if-absent must lose cleanly instead of overwriting the record back to
    // unread.
    let interleaved = false;
    const racing: UnlockedVault = {
      ...alice,
      putJsonIfUnchanged: async (kind, id, value, expected) => {
        if (!interleaved) {
          interleaved = true;
          await alice.putJsonIfUnchanged(kind, id, value, expected); // B wins the race
          await markThreadRead(alice, "bob-id", new Date("2026-10-30T13:00:00Z"));
        }
        return alice.putJsonIfUnchanged(kind, id, value, expected); // A's CAS conflicts
      },
    };
    const result = await applyInboundChatEnvelope(racing, sent.envelope, deps);
    expect(interleaved).toBe(true);
    expect(result.applied).toBe(false);
    const thread = await listChatThread(alice, "bob-id");
    expect(thread).toHaveLength(1);
    expect(thread[0]!.readAt).not.toBeNull();
    expect(result.message!.readAt).not.toBeNull();
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
    // A distinct sentAt keeps the chronological assertion deterministic: the same-second
    // tiebreak is the (now signature-derived) id, not insertion order.
    await sendChatMessage(bob, aliceConn, "two", { ...deps, now: () => new Date("2026-10-30T12:00:01Z") });
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
