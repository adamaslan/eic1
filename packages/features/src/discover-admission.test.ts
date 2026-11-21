import { describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "@veil/crypto";
import { encodeBase64 } from "@veil/core";
import { admitDirectoryPrincipal, DirectoryService, emptyDirectory, signDirectoryCommand, type DirectoryAtomicStore, type DirectoryDatabase } from "./discover-directory";
import { createRelayHttpHandler } from "./relay-http";
import { staticRelayMembership } from "./relay-enroll";
import { publisherPath } from "./chat-relay";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { defaultSettings, saveSettings } from "./social";
import { vaultDirectoryClient } from "./discover-vault";

const principalOf = async (pubkey: string) => (await publisherPath(pubkey)).slice("feeds/".length);

class MemoryDirectoryStore implements DirectoryAtomicStore {
  private generation = 0;
  private value: DirectoryDatabase = emptyDirectory();
  async read() { return { generation: String(this.generation), value: structuredClone(this.value) }; }
  async compareAndSet(expected: string, next: DirectoryDatabase) {
    if (expected !== String(this.generation)) return false;
    this.value = structuredClone(next); this.generation += 1; return true;
  }
}

describe("directory admission", () => {
  it("admits only the principal that owns the signing key, and only for members", async () => {
    const identity = await generateSigningKeyPair();
    const pubkey = encodeBase64(identity.publicKey);
    const member = (pk: string) => Promise.resolve(pk === pubkey);
    expect(await admitDirectoryPrincipal(member, await principalOf(pubkey), pubkey)).toBe(true);
    expect(await admitDirectoryPrincipal(member, "someone-else", pubkey)).toBe(false);
    const other = encodeBase64((await generateSigningKeyPair()).publicKey);
    expect(await admitDirectoryPrincipal(member, await principalOf(other), other)).toBe(false);
  });

  it("serves a signed read over the relay handler only to members; others get a rejection", async () => {
    const identity = await generateSigningKeyPair();
    const pubkey = encodeBase64(identity.publicKey);
    const principal = await principalOf(pubkey);
    const store = new MemoryDirectoryStore();
    const service = new DirectoryService(store, (p, k) => admitDirectoryPrincipal(async (pk) => pk === pubkey, p, k), () => Date.now());
    const handler = createRelayHttpHandler({} as never, {
      enabled: true, origins: ["https://app.example"], membership: staticRelayMembership([pubkey]),
      maxPublishesPerWindow: 10, windowMs: 60_000, now: () => new Date(), directory: service,
    });
    const body = JSON.stringify(await signDirectoryCommand({ domain: "eic-directory-v1", principal, seq: 1, at: Date.now(), action: "read" }, identity));
    const post = (text: string) => handler(new Request("https://relay.example/directory", { method: "POST", headers: { "content-type": "application/json" }, body: text }));
    const ok = await post(body);
    expect(ok.status).toBe(200);
    const read = await ok.json() as { cards: unknown[]; requests: unknown[] };
    expect(Array.isArray(read.cards) && Array.isArray(read.requests)).toBe(true);

    // Replaying the same sequence is refused, with no state change.
    expect((await post(body)).status).toBe(400);

    // A non-member key is refused before any state is touched.
    const stranger = await generateSigningKeyPair();
    const strangerPub = encodeBase64(stranger.publicKey);
    const strangerBody = JSON.stringify(await signDirectoryCommand({ domain: "eic-directory-v1", principal: await principalOf(strangerPub), seq: 1, at: Date.now(), action: "read" }, stranger));
    expect((await post(strangerBody)).status).toBe(400);
  });

  it("does not serve the directory action when no directory is configured", async () => {
    const identity = await generateSigningKeyPair();
    const pubkey = encodeBase64(identity.publicKey);
    const handler = createRelayHttpHandler({} as never, {
      enabled: true, origins: [], membership: staticRelayMembership([pubkey]), maxPublishesPerWindow: 10, windowMs: 60_000, now: () => new Date(),
    });
    const response = await handler(new Request("https://relay.example/directory", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(404);
  });

  it("a vault's own requests are admitted: the vault client signs as its feed hash", async () => {
    const now = Date.UTC(2026, 10, 20, 12, 0);
    const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date(now) }, "discover-admission-test");
    await saveSettings(vault, { ...defaultSettings(), authorId: "alice-id", handle: "alice" });
    const { loadOrCreateShareIdentity } = await import("./sharing");
    const identity = await loadOrCreateShareIdentity(vault);
    const pubkey = encodeBase64(identity.publicKey);
    const store = new MemoryDirectoryStore();
    const service = new DirectoryService(store, (p, k) => admitDirectoryPrincipal(async (pk) => pk === pubkey, p, k), () => now);
    const client = await vaultDirectoryClient(vault, (envelope) => service.execute(envelope), () => now);
    await expect(client.execute({ action: "read" })).resolves.toEqual({ cards: [], ownCard: null, requests: [] });
  });
});
