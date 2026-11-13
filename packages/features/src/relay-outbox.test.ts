import { describe, expect, it, vi } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { defaultSettings, saveSettings, loadSettings } from "./social";
import { buildChatFeedSnapshot } from "./chat-relay";
import { loadOrCreateShareIdentity } from "./sharing";
import { prepareRelayOutbox, attemptRelayOutbox, publishRelaySnapshot } from "./relay-outbox";

const NOW = new Date("2026-11-06T21:00:00Z");
async function fixture() {
  const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "retry-proof-only");
  await saveSettings(vault, { ...defaultSettings(), authorId: "local-owner", handle: "local", feedUrl: "https://relay.example/feeds/owner" });
  await loadOrCreateShareIdentity(vault);
  return vault;
}
const recordId = "relay-outbox:local-owner";
describe("explicit durable sealed relay retries", () => {
  it("prepares once, retries exact bytes and advances only after signed commit readback", async () => {
    const vault = await fixture(); expect(await prepareRelayOutbox(vault, NOW)).toEqual({ seq: 1, reusedPending: false });
    const pending = await vault.getJson(recordId);
    expect(await prepareRelayOutbox(vault, new Date(NOW.getTime() + 1000))).toEqual({ seq: 1, reusedPending: true });
    expect(await vault.getJson(recordId)).toEqual(pending);
    const snapshot = (pending as { pending: { manifest: string } }).pending;
    const publish = vi.fn().mockRejectedValue(new Error("Response lost after server commit"));
    const read = vi.fn().mockResolvedValue({ manifest: snapshot.manifest });
    expect(await attemptRelayOutbox(vault, { publish, read }, NOW)).toEqual({ status: "confirmed", seq: 1 });
    expect(await vault.getJson(recordId)).toMatchObject({ seq: 1, pending: null });
    expect(await prepareRelayOutbox(vault, NOW)).toEqual({ seq: 2, reusedPending: false });
  });
  it("ambiguous success and unreachable read keep pending, retry uses a fresh signed nonce", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW); const before = await vault.getJson(recordId);
    const publish = vi.fn().mockResolvedValue(undefined); const read = vi.fn().mockRejectedValue(new Error("offline"));
    expect((await attemptRelayOutbox(vault, { publish, read }, NOW)).status).toBe("pending");
    expect((await attemptRelayOutbox(vault, { publish, read }, NOW)).status).toBe("pending");
    expect(await vault.getJson(recordId)).toEqual(before);
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    expect(read.mock.calls[0][0].nonce).not.toBe(read.mock.calls[1][0].nonce);
  });
  it("tampered unsigned readback cannot clear pending", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW); const before = await vault.getJson(recordId);
    const manifest = (before as { pending: { manifest: string } }).pending.manifest.replace('"seq":1', '"seq":2');
    expect((await attemptRelayOutbox(vault, { publish: async () => {}, read: async () => ({ manifest }) }, NOW)).status).toBe("pending");
    expect(await vault.getJson(recordId)).toEqual(before);
  });
  it("concurrent preparations cannot overwrite the first pending snapshot", async () => {
    const vault = await fixture();
    const results = await Promise.allSettled([prepareRelayOutbox(vault, NOW), prepareRelayOutbox(vault, new Date(NOW.getTime() + 1000))]);
    expect(results.filter(x => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await vault.getJson(recordId)).toMatchObject({ seq: 1 });
  });
  it("concurrent state change during readback cannot be cleared by stale retry", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW);
    const before = await vault.getJson(recordId) as { seq: number; pending: { manifest: string } };
    const result = await attemptRelayOutbox(vault, { publish: async () => {}, read: async () => {
      await vault.putJson("settings", recordId, { ...before, seq: 2 }); return { manifest: before.pending.manifest };
    } }, NOW);
    expect(result.status).toBe("pending"); expect(await vault.getJson(recordId)).toMatchObject({ seq: 2, pending: before.pending });
  });
  it("changed destination, corrupted snapshot or locked vault never invokes transport", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW);
    const transport = { publish: vi.fn(), read: vi.fn() };
    await saveSettings(vault, { ...defaultSettings(), authorId: "local-owner", handle: "local", feedUrl: "https://other.example/feed" });
    await expect(attemptRelayOutbox(vault, transport, NOW)).rejects.toThrow("destination changed");
    vault.lock(); await expect(attemptRelayOutbox(vault, transport, NOW)).rejects.toThrow();
    expect(transport.publish).not.toHaveBeenCalled(); expect(transport.read).not.toHaveBeenCalled();
  });
  it("a validly signed but different committed head never clears pending", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW); const before = await vault.getJson(recordId);
    const newer = await buildChatFeedSnapshot(vault, await loadSettings(vault), { seq: 2, now: NOW });
    expect((await attemptRelayOutbox(vault, { publish: async () => {}, read: async () => ({ manifest: newer.manifest }) }, NOW)).status).toBe("pending");
    expect(await vault.getJson(recordId)).toEqual(before);
  });
  it("corrupted pending signature is rejected before handing bytes to transport", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW);
    const saved = await vault.getJson(recordId) as { pending: { manifest: string } };
    await vault.putJson("settings", recordId, { ...saved, pending: { ...saved.pending, manifest: saved.pending.manifest.replace('"seq":1', '"seq":2') } });
    const transport = { publish: vi.fn(), read: vi.fn() };
    await expect(attemptRelayOutbox(vault, transport, NOW)).rejects.toThrow();
    expect(transport.publish).not.toHaveBeenCalled(); expect(transport.read).not.toHaveBeenCalled();
  });

});

describe("publishRelaySnapshot (shared by Send and Retry)", () => {
  function relay() {
    let last: { manifest: string } | null = null;
    const publish = vi.fn(async (snapshot: { manifest: string }) => { last = snapshot; });
    const read = vi.fn(async () => ({ manifest: last!.manifest }));
    return { publish, read };
  }
  it("sends one snapshot when nothing was pending", async () => {
    const vault = await fixture(); const transport = relay();
    expect(await publishRelaySnapshot(vault, transport as never, () => NOW)).toEqual({ status: "confirmed", seq: 1 });
    expect(transport.publish).toHaveBeenCalledTimes(1);
  });
  it("after an offline attempt, Retry confirms the old snapshot and then sends a fresh one", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW);
    await attemptRelayOutbox(vault, { publish: async () => { throw new Error("offline"); }, read: async () => { throw new Error("offline"); } }, NOW);
    expect(await vault.getJson(recordId)).toMatchObject({ seq: 1 });
    const transport = relay();
    expect(await publishRelaySnapshot(vault, transport as never, () => NOW)).toEqual({ status: "confirmed", seq: 2 });
    expect(transport.publish).toHaveBeenCalledTimes(2);
    expect(await vault.getJson(recordId)).toMatchObject({ seq: 2, pending: null });
  });
  it("if the fresh snapshot cannot be confirmed it stays pending for the next retry", async () => {
    const vault = await fixture(); await prepareRelayOutbox(vault, NOW);
    let calls = 0; let last = "";
    const transport = { publish: async (s: { manifest: string }) => { last = s.manifest; },
      read: async () => { if (++calls > 1) throw new Error("offline"); return { manifest: last }; } };
    expect(await publishRelaySnapshot(vault, transport as never, () => NOW)).toEqual({ status: "pending", seq: 2 });
    expect(await vault.getJson(recordId)).toMatchObject({ seq: 2, pending: expect.anything() });
  });
});
