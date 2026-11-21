import { describe, expect, it, vi } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildShareBundle, importShareBundle } from "./sharing";
import { defaultSettings, listConnections, saveSettings, type Settings } from "./social";
import { listChatThread, outboundStatus, sendChatMessage, type ChatDeps } from "./chat";
import { attemptRelayOutbox, hasUnacceptedOutbound, prepareRelayOutbox, publishRelaySnapshot } from "./relay-outbox";

// Synthetic local vaults only. No network, no hosted relay.
const NOW = new Date("2026-11-20T12:00:00.000Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string, feedUrl: string | null = null): Settings => ({ ...defaultSettings(), authorId, handle, feedUrl });
let counter = 0;
// Same instant for every message: the case a sentAt cutoff cannot tell apart.
const sameMs: ChatDeps = { newId: () => `m${counter++}`, now: () => NOW };
const BOB_FEED = "https://relay.example/feeds/bob";

async function pair(): Promise<{ bob: UnlockedVault; aliceId: string }> {
  const alice = await open(); const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice")); await saveSettings(bob, settingsFor("bob-id", "bob", BOB_FEED));
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob", BOB_FEED), newId: sameMs.newId, now: NOW });
  return { bob, aliceId: "alice-id" };
}
const relay = () => { let last: { manifest: string } | null = null; return {
  publish: vi.fn(async (r: { manifest: string }) => { last = r; }), read: vi.fn(async () => ({ manifest: last!.manifest })) }; };
const sigsInSnapshot = (snapshot: { files: { path: string; text: string }[] }, to: string) =>
  (JSON.parse(snapshot.files.find((f) => f.path === `chunks/chat-${to}.json`)!.text).envelopes as { signature: string }[]).map((e) => e.signature);
const recordId = "relay-outbox:bob-id";

describe("accepted means this exact envelope was in the confirmed snapshot", () => {
  it("a second message saved in the same millisecond after the snapshot is built stays queued and retryable", async () => {
    const { bob, aliceId } = await pair();
    const alice = (await listConnections(bob)).find((c) => c.id === aliceId)!;
    const first = await sendChatMessage(bob, alice, "first", sameMs);
    await prepareRelayOutbox(bob, NOW);
    const second = await sendChatMessage(bob, alice, "second, same millisecond", sameMs);
    expect(second.sentAt).toBe(first.sentAt);

    const pending = (await bob.getJson(recordId)) as { pending: { manifest: string; files: { path: string; text: string }[] } };
    // The snapshot holds the first message only.
    expect(sigsInSnapshot(pending.pending, aliceId)).toEqual([(first.envelope as { signature: string }).signature]);

    // Ambiguous publish: the response is lost and the readback is not our head. Pending bytes and membership survive.
    const before = await bob.getJson(recordId);
    expect((await attemptRelayOutbox(bob, { publish: async () => { throw new Error("lost"); }, read: async () => { throw new Error("offline"); } }, NOW)).status).toBe("pending");
    expect(await bob.getJson(recordId)).toEqual(before);

    // Signed readback confirms the first snapshot.
    const transport = relay();
    expect((await attemptRelayOutbox(bob, transport, NOW)).status).toBe("confirmed");
    const thread = await listChatThread(bob, aliceId);
    const status = (id: string) => outboundStatus(thread.find((m) => m.id === id)!);
    expect(status(first.id)).toBe("accepted");
    expect(status(second.id)).toBe("queued");           // omitted, so not accepted
    expect(await hasUnacceptedOutbound(bob)).toBe(true); // and still eligible for automatic retry

    // The retry carries it, and only then is it accepted. Neither is delivered.
    expect((await publishRelaySnapshot(bob, transport, () => NOW)).status).toBe("confirmed");
    const after = await listChatThread(bob, aliceId);
    expect(after.map((m) => outboundStatus(m))).toEqual(["accepted", "accepted"]);
    expect(await hasUnacceptedOutbound(bob)).toBe(false);
  });

  it("reload keeps the same membership: a fresh vault reader sees the pending bytes and members unchanged", async () => {
    const { bob, aliceId } = await pair();
    const alice = (await listConnections(bob)).find((c) => c.id === aliceId)!;
    await sendChatMessage(bob, alice, "one", sameMs);
    await prepareRelayOutbox(bob, NOW);
    const saved = (await bob.getJson(recordId)) as { pendingMembers: { outbound: string[] } };
    await sendChatMessage(bob, alice, "two", sameMs);
    expect(await prepareRelayOutbox(bob, new Date(NOW.getTime() + 5000))).toMatchObject({ reusedPending: true });
    expect(((await bob.getJson(recordId)) as { pendingMembers: { outbound: string[] } }).pendingMembers).toEqual(saved.pendingMembers);
    expect(saved.pendingMembers.outbound).toHaveLength(1);
  });
});
