import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import { countingStore, type RelayAtomicStore, type StoreEntry } from "./relay-adapter";
import {
  RELAY_INVITE_TTL_MS,
  RelayEnrollDeniedError,
  admitRelayEnroll,
  createMemoryRelayMembership,
  signRelayEnroll,
  signRelayInvite,
  type RelayInvite,
} from "./relay-enroll";
import { createRelayHttpHandler } from "./relay-http";
import { FEED_FORMAT, FEED_VERSION } from "./feed";

const NOW = new Date("2026-11-19T12:00:00Z");
function memStore(): RelayAtomicStore {
  const data = new Map<string, StoreEntry>(); let gen = 0;
  return {
    async get(path) { return data.get(path) ?? null; },
    async compareAndSet(path, text, cond) {
      const cur = data.get(path);
      if ("createOnly" in cond ? cur : !cur || cur.generation !== cond.generation) return null;
      const generation = String(++gen); data.set(path, { data: text, generation }); return generation;
    },
    async putObject(path, text) { const cur = data.get(path); if (cur && cur.data !== text) throw new Error("immutable"); data.set(path, { data: text, generation: String(++gen) }); },
    async list(prefix) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort() }; },
    async delete(path) { data.delete(path); },
  };
}
const pub = (k: { publicKey: Uint8Array }) => encodeBase64(k.publicKey);

async function setup() {
  const root = await generateSigningKeyPair(); const friend = await generateSigningKeyPair();
  const membership = createMemoryRelayMembership([pub(root)]);
  return { root, friend, membership, store: memStore(), invite: await signRelayInvite(root, NOW) };
}

describe("vouched relay enrollment", () => {
  it("admits a key vouched by a member, and a repeat is idempotent without spending the invite", async () => {
    const { friend, membership, store, invite } = await setup();
    expect((await admitRelayEnroll(store, membership, await signRelayEnroll(friend, invite, NOW), { now: NOW })).status).toBe("enrolled");
    expect(await membership.isMember(pub(friend))).toBe(true);
    expect((await admitRelayEnroll(store, membership, await signRelayEnroll(friend, invite, NOW), { now: NOW })).status).toBe("member");
    expect([...membership.members.values()].filter((m) => m.inviteId === invite.inviteId)).toHaveLength(1);
  });

  it("rejects forged proofs and forged invites with zero store operations", async () => {
    const { root, friend, membership, store, invite } = await setup();
    const { store: counted, ops } = countingStore(store);
    const good = await signRelayEnroll(friend, invite, NOW);
    const mallory = await generateSigningKeyPair();
    const forgedInvite: RelayInvite = { ...(await signRelayInvite(mallory, NOW)), inviterPub: pub(root) };
    for (const request of [
      { ...good, pubkey: pub(mallory) },
      { ...good, invite: { ...invite, inviteId: "A".repeat(24) } },
      await signRelayEnroll(friend, forgedInvite, NOW),
      { ...good, invite: { ...invite, expiresAt: invite.expiresAt + 1 } },
    ]) await expect(admitRelayEnroll(counted, membership, request, { now: NOW })).rejects.toThrow();
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
    expect(await membership.isMember(pub(friend))).toBe(false);
  });

  it("rejects stale requests, expired invites and invites that claim to outlive the TTL", async () => {
    const { root, friend, membership, store, invite } = await setup();
    const later = new Date(NOW.getTime() + RELAY_INVITE_TTL_MS + 1);
    await expect(admitRelayEnroll(store, membership, await signRelayEnroll(friend, invite, NOW), { now: new Date(NOW.getTime() + 6 * 60 * 1000) })).rejects.toThrow(/too old/);
    await expect(admitRelayEnroll(store, membership, await signRelayEnroll(friend, invite, later), { now: later })).rejects.toThrow(/expired/);
    const farFuture = await signRelayInvite(root, new Date(NOW.getTime() + RELAY_INVITE_TTL_MS));
    await expect(admitRelayEnroll(store, membership, await signRelayEnroll(friend, farFuture, NOW), { now: NOW })).rejects.toThrow(/not valid/);
  });

  it("rejects a replayed nonce", async () => {
    const { friend, membership, store, invite } = await setup();
    const request = await signRelayEnroll(friend, invite, NOW);
    await admitRelayEnroll(store, membership, request, { now: NOW });
    await expect(admitRelayEnroll(store, membership, request, { now: NOW })).rejects.toThrow(/already been used/);
  });

  it("denies a non-member's invite, so strangers cannot vouch for each other", async () => {
    const { friend, membership, store } = await setup();
    const stranger = await generateSigningKeyPair();
    const error = await admitRelayEnroll(store, membership, await signRelayEnroll(friend, await signRelayInvite(stranger, NOW), NOW), { now: NOW }).catch((e) => e);
    expect(error).toBeInstanceOf(RelayEnrollDeniedError); expect(error.reason).toBe("inviter_not_member");
  });

  it("enforces uses per invite, vouches per member and the member cap", async () => {
    const root = await generateSigningKeyPair(); const store = memStore();
    const membership = createMemoryRelayMembership([pub(root)], { maxMembers: 4, invitesPerMember: 2, usesPerInvite: 1 });
    const reason = async (invite: RelayInvite) => {
      const key = await generateSigningKeyPair();
      return admitRelayEnroll(store, membership, await signRelayEnroll(key, invite, NOW), { now: NOW }).then((r) => r.status, (e) => e.reason);
    };
    const first = await signRelayInvite(root, NOW);
    expect(await reason(first)).toBe("enrolled");
    expect(await reason(first)).toBe("invite_used");
    expect(await reason(await signRelayInvite(root, NOW))).toBe("enrolled");
    expect(await reason(await signRelayInvite(root, NOW))).toBe("inviter_quota");
    const child = [...membership.members.entries()].find(([, m]) => m.inviter === pub(root))![0];
    expect(child).toBeTruthy();
    // Cap: root + 2 children = 3; a grandchild fills 4, the next is refused.
    const childKey = await generateSigningKeyPair();
    membership.members.set(pub(childKey), { inviter: null, inviteId: null });
    expect(await reason(await signRelayInvite(childKey, NOW))).toBe("capacity");
  });
});

describe("relay HTTP with membership", () => {
  async function manifestFor(key: Awaited<ReturnType<typeof generateSigningKeyPair>>) {
    const unsigned = { format: FEED_FORMAT, version: FEED_VERSION, authorId: "fixture", feedUrl: "https://relay.example/feeds/x", pubkey: pub(key), seq: 1, builtAt: NOW.toISOString(), chunks: [] };
    const signature = encodeBase64(await signPayload(key.secretKey, new TextEncoder().encode(JSON.stringify(unsigned))));
    const manifest = JSON.stringify({ ...unsigned, signature });
    return { manifest, files: [{ path: "feed.json", text: manifest }] };
  }
  it("publish is refused before enrollment, allowed after, and a denied invite is 403", async () => {
    const { root, friend, membership, store, invite } = await setup();
    const handle = createRelayHttpHandler(store, { enabled: true, origins: ["https://eic.example"], membership, maxPublishesPerWindow: 5, windowMs: 60000, now: () => NOW });
    const post = (action: string, body: unknown) => handle(new Request(`https://local.invalid/${action}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://eic.example" }, body: JSON.stringify(body) }));
    expect((await post("publish", await manifestFor(friend))).status).toBe(400);
    const stranger = await generateSigningKeyPair();
    expect((await post("enroll", await signRelayEnroll(friend, await signRelayInvite(stranger, NOW), NOW))).status).toBe(403);
    const enrolled = await post("enroll", await signRelayEnroll(friend, invite, NOW));
    expect(enrolled.status).toBe(200); expect(await enrolled.json()).toEqual({ status: "enrolled" });
    expect((await post("publish", await manifestFor(friend))).status).toBe(200);
    expect((await post("publish", await manifestFor(root))).status).toBe(200);
    expect((await post("enroll", { pubkey: "x" })).status).toBe(400);
  });
});
