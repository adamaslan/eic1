import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../../../packages/vault/src/memory-store";
import {
  buildShareBundle, importSealedConnect, loadOrCreateShareIdentity, sealConnectBundle,
  admitDirectoryPrincipal, defaultSettings, DirectoryService, emptyDirectory, listConnections, listChatThread,
  configureRelayFeed, loadSettings, myPrincipal, saveSettings, sendChatMessage, vaultDirectoryClient, type DirectoryAtomicStore, type DirectoryDatabase,
} from "@veil/features";
import { sealSyncEnvelope } from "@veil/crypto";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { signedDirectoryAdapter } from "./discover-signed-adapter";

const NOW = Date.UTC(2026, 10, 20, 12, 0);

class MemoryDirectoryStore implements DirectoryAtomicStore {
  private generation = 0;
  private value: DirectoryDatabase = emptyDirectory();
  async read() { return { generation: String(this.generation), value: structuredClone(this.value) }; }
  async compareAndSet(expected: string, next: DirectoryDatabase) {
    if (expected !== String(this.generation)) return false;
    this.value = structuredClone(next); this.generation += 1; return true;
  }
}

async function person(authorId: string, handle: string, service: DirectoryService) {
  const vault: UnlockedVault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date(NOW) }, `discover-${handle}`);
  await saveSettings(vault, { ...defaultSettings(), authorId, handle });
  const client = await vaultDirectoryClient(vault, (envelope) => service.execute(envelope), () => NOW);
  const adapter = signedDirectoryAdapter(client, vault);
  await adapter.publish({ name: handle, handle, bio: `${handle} bio` });
  return { vault, adapter, principal: await myPrincipal(vault), authorId };
}

async function setup() {
  // Every key that reaches this test is a member. Admission still binds principal to key.
  const service = new DirectoryService(new MemoryDirectoryStore(), (principal, pubkey) => admitDirectoryPrincipal(async () => true, principal, pubkey), () => NOW);
  const alice = await person("alice-id", "alice", service);
  const bob = await person("bob-id", "bob", service);
  const eve = await person("eve-id", "eve", service);
  return { alice, bob, eve };
}

describe("Discover connect carries a feed to pull from", () => {
  async function pair(prepare: (vault: UnlockedVault) => (() => Promise<void>) | undefined) {
    const service = new DirectoryService(new MemoryDirectoryStore(), (principal, pubkey) => admitDirectoryPrincipal(async () => true, principal, pubkey), () => NOW);
    const make = async (authorId: string, handle: string) => {
      const vault: UnlockedVault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date(NOW) }, `feed-${handle}`);
      await saveSettings(vault, { ...defaultSettings(), authorId, handle });
      const client = await vaultDirectoryClient(vault, (envelope) => service.execute(envelope), () => NOW);
      const adapter = signedDirectoryAdapter(client, vault, prepare(vault));
      await adapter.publish({ name: handle, handle, bio: `${handle} bio` });
      return { vault, adapter, principal: await myPrincipal(vault) };
    };
    return { alice: await make("alice-id", "alice"), bob: await make("bob-id", "bob") };
  }
  const ENDPOINT = "http://127.0.0.1:54321/functions/v1/eic-relay";

  it("without a feed step the friend imports a connection with no feed (the defect this guards)", async () => {
    const { alice, bob } = await pair(() => undefined);
    await alice.adapter.request(bob.principal); await bob.adapter.accept(alice.principal);
    expect((await listConnections(bob.vault))[0]?.feedUrl).toBeNull();
  });

  it("with the feed step both directions carry the sender's own feed", async () => {
    const { alice, bob } = await pair((vault) => async () => { await configureRelayFeed(vault, ENDPOINT); });
    await alice.adapter.request(bob.principal); await bob.adapter.accept(alice.principal); await alice.adapter.read();
    const aliceFeed = (await loadSettings(alice.vault)).feedUrl; const bobFeed = (await loadSettings(bob.vault)).feedUrl;
    expect(aliceFeed?.startsWith(`${ENDPOINT}/feeds/`)).toBe(true);
    expect((await listConnections(bob.vault))[0]?.feedUrl).toBe(aliceFeed);
    expect((await listConnections(alice.vault))[0]?.feedUrl).toBe(bobFeed);
  });

  it("a failing feed step stops the request: nothing feedless is sealed or sent", async () => {
    const { alice, bob } = await pair(() => async () => { throw new Error("feed setup failed"); });
    await expect(alice.adapter.request(bob.principal)).rejects.toThrow("feed setup failed");
    expect((await bob.adapter.read()).incoming).toEqual([]);
  });
});

describe("Discover connect: request, accept, then chat", () => {
  it("a pending request creates no connection on either side", async () => {
    const { alice, bob } = await setup();
    await alice.adapter.request(bob.principal);
    expect((await listConnections(bob.vault)).map((c) => c.id)).toEqual([]);
    expect((await listConnections(alice.vault)).map((c) => c.id)).toEqual([]);
    // The target sees the pending request; the requester sees nothing to accept.
    expect((await bob.adapter.read()).incoming).toEqual([alice.principal]);
    expect((await alice.adapter.read()).incoming).toEqual([]);
  });

  it("accepting imports the requester's connect; the requester then imports the reply on read", async () => {
    const { alice, bob } = await setup();
    await alice.adapter.request(bob.principal);
    await bob.adapter.accept(alice.principal);
    expect((await listConnections(bob.vault)).map((c) => c.id)).toEqual(["alice-id"]);
    expect((await listConnections(alice.vault)).map((c) => c.id)).toEqual([]);
    await alice.adapter.read();
    expect((await listConnections(alice.vault)).map((c) => c.id)).toEqual(["bob-id"]);
    // A second read imports nothing new.
    await alice.adapter.read(); await bob.adapter.read();
    expect((await listConnections(alice.vault))).toHaveLength(1);
    expect((await listConnections(bob.vault))).toHaveLength(1);
  });

  it("after accepting, both sides can send and the message is stored on the sender", async () => {
    const { alice, bob } = await setup();
    await alice.adapter.request(bob.principal);
    await bob.adapter.accept(alice.principal);
    await alice.adapter.read();
    const bobAsSeenByAlice = (await listConnections(alice.vault)).find((c) => c.id === "bob-id")!;
    const sent = await sendChatMessage(alice.vault, bobAsSeenByAlice, "hi from discover", { newId: () => "m1", now: () => new Date(NOW) });
    expect(sent.body).toBe("hi from discover");
    expect((await listChatThread(alice.vault, "bob-id")).map((m) => m.body)).toEqual(["hi from discover"]);
  });

  it("declining creates no connection and reveals no connect material", async () => {
    const { alice, bob, eve } = await setup();
    await eve.adapter.request(bob.principal);
    await bob.adapter.decline(eve.principal);
    expect((await listConnections(bob.vault)).map((c) => c.id)).toEqual([]);
    await eve.adapter.read();
    expect((await listConnections(eve.vault))).toEqual([]);
    expect((await bob.adapter.read()).incoming).toEqual([]);
  });

  it("a stranger cannot accept someone else's request", async () => {
    const { alice, bob, eve } = await setup();
    await alice.adapter.request(bob.principal);
    // Eve has no request from Alice to accept.
    await expect(eve.adapter.accept(alice.principal)).rejects.toThrow("No incoming request");
    expect((await listConnections(bob.vault))).toEqual([]);
  });

  it("a sealed connect must carry its sender's own signed bundle", async () => {
    const { alice, bob, eve } = await setup();
    // Eve seals ALICE's bundle to Bob. The envelope is genuinely Eve's, but the bundle inside is not.
    const aliceSettings = { ...defaultSettings(), authorId: "alice-id", handle: "alice" };
    const bundle = (await buildShareBundle(alice.vault, aliceSettings, [], new Date(NOW))).text;
    const eveKey = encodeBase64((await loadOrCreateShareIdentity(eve.vault)).publicKey);
    const bobKey = encodeBase64((await loadOrCreateShareIdentity(bob.vault)).publicKey);
    const sealed = JSON.stringify(await sealSyncEnvelope({
      secretKey: (await loadOrCreateShareIdentity(eve.vault)).secretKey, authorId: eve.principal, recipientAuthorId: bob.principal,
      recipientPublicKey: decodeBase64(bobKey), kind: "chat", plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, bundle })),
    }));
    await expect(importSealedConnect(bob.vault, sealed, eveKey, { newId: () => "x", now: new Date(NOW) })).rejects.toThrow("not signed by the person who sent it");
    expect((await listConnections(bob.vault)).map((c) => c.id)).toEqual([]);
  });

  it("nobody can replace an existing friend by claiming their author id", async () => {
    const { alice, bob, eve } = await setup();
    // Bob and Alice are connected for real.
    await alice.adapter.request(bob.principal);
    await bob.adapter.accept(alice.principal);
    await alice.adapter.read();
    const alicePubkey = encodeBase64((await loadOrCreateShareIdentity(alice.vault)).publicKey);
    expect((await listConnections(bob.vault)).find((c) => c.id === "alice-id")?.pubkey).toBe(alicePubkey);
    // Eve's vault now claims Alice's author id. Its genuine sealed connect is signed by Eve's key, not Alice's.
    await saveSettings(eve.vault, { ...defaultSettings(), authorId: "alice-id", handle: "alice" });
    const eveKey = encodeBase64((await loadOrCreateShareIdentity(eve.vault)).publicKey);
    const bobKey = encodeBase64((await loadOrCreateShareIdentity(bob.vault)).publicKey);
    const forged = await sealConnectBundle(eve.vault, bob.principal, bobKey, new Date(NOW));
    await expect(importSealedConnect(bob.vault, forged, eveKey, { newId: () => "y", now: new Date(NOW) })).rejects.toThrow("would replace an existing friend");
    expect((await listConnections(bob.vault)).find((c) => c.id === "alice-id")?.pubkey).toBe(alicePubkey);
  });
});
