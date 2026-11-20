import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../../../packages/vault/src/memory-store";
import {
  admitDirectoryPrincipal, defaultSettings, DirectoryService, emptyDirectory, listConnections, listChatThread,
  myPrincipal, saveSettings, sendChatMessage, vaultDirectoryClient, type DirectoryAtomicStore, type DirectoryDatabase,
} from "@veil/features";
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
});
