import { describe, it, expect } from "vitest";
import { encodeBase64 } from "@veil/core";
import { SubtleCryptoPort, generateSigningKeyPair } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { loadOrCreateShareIdentity } from "./sharing";
import { defaultSettings, saveSettings, listConnections } from "./social";
import { DirectoryService, SignedDirectoryClient, emptyDirectory, signDirectoryCommand, type DirectoryAtomicStore, type DirectoryDatabase } from "./discover-directory";
import { nextDirectorySequence } from "./discover-vault";

class AtomicMemory implements DirectoryAtomicStore {
  generation = 0; value: DirectoryDatabase = emptyDirectory(); reads = 0; writes = 0;
  async read() { this.reads++; return { generation: String(this.generation), value: structuredClone(this.value) }; }
  async compareAndSet(generation: string, value: DirectoryDatabase) {
    if (generation !== String(this.generation)) return false;
    this.writes++; this.value = structuredClone(value); this.generation++; return true;
  }
}
const time = Date.UTC(2026, 10, 19, 19, 0);
const draft = { name: "Chosen Name", handle: "chosen", bio: "Only this chosen bio" };
async function setup() {
  const now = { value: time }; const store = new AtomicMemory(); const keys = new Map<string, string>();
  const service = new DirectoryService(store, async (principal, pubkey) => keys.get(principal) === pubkey, () => now.value);
  async function actor(id: string) {
    const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date(time) }, "synthetic-directory-test");
    await saveSettings(vault, { ...defaultSettings(), authorId: id, handle: id });
    const identity = await loadOrCreateShareIdentity(vault); keys.set(id, encodeBase64(identity.publicKey));
    // Principal = account id here, so the protocol fixtures stay readable. The vault-to-feed-hash binding
    // is covered in discover-admission.test.ts.
    const client = new SignedDirectoryClient(id, identity, () => nextDirectorySequence(vault), (envelope) => service.execute(envelope), () => now.value);
    return { id, vault, identity, client };
  }
  return { store, keys, service, now, actor };
}

describe("signed local directory service + vault adapter integration, no hosted writes", () => {
  it("runs two encrypted vaults through chosen card, signed request, recipient-only acceptance and hide", async () => {
    const { actor, store } = await setup(); const alice = await actor("alice"); const bob = await actor("bob"); const eve = await actor("eve");
    await bob.client.execute({ action: "publish", card: draft });
    const browse = await alice.client.execute({ action: "read" }); expect(browse.cards.map((c) => c.id)).toEqual(["bob"]);
    const sent = await alice.client.execute({ action: "request", target: "bob", sealed: "sealed-test" }); expect(sent.requests[0].status).toBe("pending");
    expect((await eve.client.execute({ action: "read" })).requests).toEqual([]);
    await expect(eve.client.execute({ action: "accept", target: "alice", sealed: "sealed-test" })).rejects.toThrow("No incoming");
    const accepted = await bob.client.execute({ action: "accept", target: "alice", sealed: "sealed-test" }); expect(accepted.requests[0].status).toBe("accepted");
    await bob.client.execute({ action: "hide" });
    const hidden = await alice.client.execute({ action: "read" }); expect(hidden.cards).toEqual([]); expect(hidden.requests[0].status).toBe("accepted");
    expect(await listConnections(alice.vault)).toEqual([]); expect(await listConnections(bob.vault)).toEqual([]);
    expect(JSON.stringify(store.value)).not.toContain("private");
  });
  it("verifies Ed25519 signatures and admitted principal/key binding before any storage access", async () => {
    const { actor, service, store } = await setup(); const alice = await actor("alice"); const impostor = await generateSigningKeyPair();
    const command = { domain: "eic-directory-v1" as const, principal: "alice", seq: 1, at: time, action: "publish" as const, card: draft };
    await expect(service.execute(await signDirectoryCommand(command, impostor))).rejects.toThrow("not admitted"); expect(store.reads).toBe(0);
    const signed = await signDirectoryCommand(command, alice.identity); signed.command = { ...command, card: { ...draft, name: "forged" } };
    await expect(service.execute(signed)).rejects.toThrow("signature"); expect(store.reads).toBe(0);
  });
  it("rejects replay, stale timestamp, wrong domain and extra private fields", async () => {
    const { actor, service } = await setup(); const alice = await actor("alice");
    const command = { domain: "eic-directory-v1" as const, principal: "alice", seq: 1, at: time, action: "read" as const };
    const signed = await signDirectoryCommand(command, alice.identity); await service.execute(signed); await expect(service.execute(signed)).rejects.toThrow("Replayed");
    await expect(service.execute(await signDirectoryCommand({ ...command, seq: 2, at: time - 300_001 }, alice.identity))).rejects.toThrow("expired");
    await expect(service.execute({ ...signed, command: { ...command, domain: "other" } })).rejects.toThrow();
    await expect(service.execute({ ...signed, command: { ...command, action: "publish", card: { ...draft, privateNotes: "no" } } })).rejects.toThrow();
  });
  it("deduplicates retries across new sequences and does not resurrect declined requests", async () => {
    const { actor } = await setup(); const a = await actor("alice"); const b = await actor("bob"); await b.client.execute({ action: "publish", card: draft });
    await a.client.execute({ action: "request", target: "bob", sealed: "sealed-test" }); await a.client.execute({ action: "request", target: "bob", sealed: "sealed-test" });
    expect((await b.client.execute({ action: "read" })).requests).toHaveLength(1);
    await b.client.execute({ action: "decline", target: "alice" });
    expect((await a.client.execute({ action: "request", target: "bob", sealed: "sealed-test" })).requests[0].status).toBe("declined");
  });
  it("expires public cards and rejects requests to hidden, expired or self targets", async () => {
    const { actor, now } = await setup(); const a = await actor("alice"); const b = await actor("bob");
    await expect(a.client.execute({ action: "request", target: "bob", sealed: "sealed-test" })).rejects.toThrow("unavailable");
    await b.client.execute({ action: "publish", card: draft }); now.value += 7 * 86_400_000 + 1;
    expect((await a.client.execute({ action: "read" })).cards).toEqual([]);
    await expect(a.client.execute({ action: "request", target: "bob", sealed: "sealed-test" })).rejects.toThrow("unavailable");
    await expect(a.client.execute({ action: "request", target: "alice", sealed: "sealed-test" })).rejects.toThrow("unavailable");
  });
  it("serializes duplicate signed commands with CAS, so at most one replay commits", async () => {
    const { actor, service, store } = await setup(); const a = await actor("alice");
    const signed = await signDirectoryCommand({ domain: "eic-directory-v1", principal: "alice", seq: 1, at: time, action: "read" }, a.identity);
    const results = await Promise.allSettled([service.execute(signed), service.execute(signed)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(store.writes).toBe(1);
  });
  it("persists atomic sequence reservations across parallel callers and client recreation", async () => {
    const { actor, service, now } = await setup(); const a = await actor("alice");
    const seqs = await Promise.all(Array.from({ length: 4 }, () => nextDirectorySequence(a.vault))); expect(new Set(seqs).size).toBe(4);
    const client = new SignedDirectoryClient(a.id, a.identity, () => nextDirectorySequence(a.vault), (request) => service.execute(request), () => now.value);
    await client.execute({ action: "read" }); expect(await nextDirectorySequence(a.vault)).toBe(6);
  });
  it("never resets a malformed local sequence counter", async () => {
    const { actor } = await setup(); const a = await actor("alice"); await a.vault.putJson("settings", "directory-sequence", "broken");
    await expect(nextDirectorySequence(a.vault)).rejects.toThrow("damaged");
  });
  it("bounds admitted identity request traffic", async () => {
    const { actor } = await setup(); const a = await actor("alice");
    for (let i = 0; i < 30; i++) await a.client.execute({ action: "read" });
    await expect(a.client.execute({ action: "read" })).rejects.toThrow("rate limit");
  });
  it("rejects special object-property identifiers", async () => {
    const { service } = await setup();
    await expect(service.execute({ command: { domain: "eic-directory-v1", principal: "__proto__", seq: 1, at: time, action: "read" }, pubkey: "", signature: "" })).rejects.toThrow();
  });
});
