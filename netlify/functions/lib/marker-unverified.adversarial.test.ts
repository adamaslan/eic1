// Reviewer adversarial suite (marker-unverified.adversarial.test), integrated with the
// INTENDED assertions: a saturated unverified bucket must never silently drop a
// legitimate pending revoke - it fails loudly so the client keeps the pending delete
// key - and junk writes must never extend the marker's TTL window, so a retry after
// the junk expires is durably recorded and blocks the delayed create it meant to.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import { createShare, deleteShare, readShare, type ShareStore, type ShareStoreEntry } from "./share-core.ts";

let lastPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
const memoryStore = (): ShareStore & { entries: Map<string, ShareStoreEntry> } => {
  const entries = new Map<string, ShareStoreEntry>();
  let etagSeq = 0;
  return {
    entries,
    put: async (key, body, meta, condition) => {
      const existing = entries.get(key);
      if (condition?.onlyIfNew && existing) return { modified: false };
      if (condition?.onlyIfMatch && (!existing || existing.etag !== condition.onlyIfMatch)) return { modified: false };
      etagSeq += 1;
      entries.set(key, { body, meta, etag: String(etagSeq) });
      return { modified: true };
    },
    get: async (key) => entries.get(key) ?? null,
    delete: async (key) => { entries.delete(key); },
    list: async () => [...entries.keys()],
  };
};
const provisionFor = () => ({ id: randomBytes(12).toString("base64url"), deleteKey: randomBytes(24).toString("base64url") });
const signedBundle = async (): Promise<string> => {
  const pair = await generateSigningKeyPair();
  lastPair = pair;
  const unsigned = {
    format: "eic-share", version: 2, exportedAt: "2026-11-01T00:00:00.000Z",
    author: { id: "a", handle: "t", pubkey: encodeBase64(pair.publicKey) },
    posts: [{ id: "p1", type: "text", title: "x", category: "general", priceCents: null,
      description: "d", createdAt: "2026-11-01T00:00:00.000Z", likes: 0, likedBy: [], media: [], thumb: null }],
    likes: [], likesComplete: false,
  };
  const signature = await signPayload(pair.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  return JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
};
const proofFor = async (text: string, now: Date, provision: { id: string; deleteKey: string }) => {
  const at = now.toISOString();
  const digest = createHash("sha256").update(text).digest("hex");
  const keyDigest = createHash("sha256").update(provision.deleteKey).digest("hex");
  const signature = await signPayload(lastPair.secretKey, new TextEncoder().encode(`eic-share-publish:v1\n${digest}\n${at}\n${provision.id}\n${keyDigest}`));
  return { signature: encodeBase64(signature), at, id: provision.id };
};
const T0 = new Date("2026-11-01T12:00:00.000Z");
const ownerHashOf = (p: { deleteKey: string }) => createHash("sha256").update(p.deleteKey).digest("hex");

describe("adversarial: unverified bucket mechanics", () => {
  it("a saturated unverified bucket refuses loudly (no silent drop); the pending key's retry after the junk window blocks the delayed create", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    // 64 junk writes inside one 15-minute window (7 IPs stay under the 10/hr rate limit).
    for (let i = 0; i < 64; i += 1) {
      await deleteShare(store, provision.id, randomBytes(24).toString("base64url"), new Date(T0.getTime() + i * 1000), `ip-${i % 7}`);
    }
    // Owner's pending-intent revoke (correct key, absent id), bucket full: LOUD failure,
    // never a silently dropped hash reported as revoked.
    await expect(
      deleteShare(store, provision.id, provision.deleteKey, new Date(T0.getTime() + 65 * 1000), "owner"),
    ).rejects.toThrow(/contended|try again/i);
    const marker = await store.get(`revoked/${provision.id}`);
    expect(JSON.parse(marker!.body).unverified).not.toContain(ownerHashOf(provision));
    // Junk did not extend the window: deletedAt is still the first junk write's time.
    expect(marker!.meta.deletedAt).toBe(T0.toISOString());
    // After the original window expires, the retained pending key retries and IS recorded.
    const retryAt = new Date(T0.getTime() + 16 * 60 * 1000);
    await deleteShare(store, provision.id, provision.deleteKey, retryAt, "owner");
    const set = JSON.parse((await store.get(`revoked/${provision.id}`))!.body);
    expect(set.unverified).toContain(ownerHashOf(provision));
    // The delayed create the revoke was meant to block is now blocked (410).
    const t = new Date(retryAt.getTime() + 60 * 1000);
    await expect(createShare(store, text, t, await proofFor(text, t, provision), provision, "owner")).rejects.toThrow(/revoked/i);
    expect(await readShare(store, provision.id, t)).toBeNull();
  });

  it("junk writes do not extend the marker window, and an expired marker set resets on write: stale junk carries no weight", async () => {
    const store = memoryStore();
    const provision = provisionFor();
    // Junk at 1-minute spacing: every write after the TTL resets, so the bucket can
    // never accumulate past one window's worth of junk, and deletedAt never runs ahead.
    for (let i = 0; i < 64; i += 1) {
      await deleteShare(store, provision.id, randomBytes(24).toString("base64url"), new Date(T0.getTime() + i * 60 * 1000), `ip-${i % 7}`);
    }
    // Past the last junk write's own window: the stale set is discarded, not merged.
    const later = new Date(T0.getTime() + 80 * 60 * 1000);
    await deleteShare(store, provision.id, provision.deleteKey, later, "owner");
    const marker = await store.get(`revoked/${provision.id}`);
    const set = JSON.parse(marker!.body);
    expect(set.unverified.length).toBe(1); // reset, not 64+1
    expect(set.unverified).toContain(ownerHashOf(provision));
    expect(marker!.meta.deletedAt).toBe(later.toISOString());
  });

  it("verified bucket FIFO at 16: a 17th distinct live-key revoke evicts the oldest verified hash", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    // 17 incarnations of the same id, each live-key revoked within the TTL.
    for (let i = 0; i < 17; i += 1) {
      const t = new Date(T0.getTime() + i * 30 * 1000);
      const key = i === 0 ? provision.deleteKey : randomBytes(24).toString("base64url");
      // Simulate an entry existing with THIS key's hash, then a key-checked delete.
      await store.put(`posts/${provision.id}`, text, { createdAt: t.toISOString(), deleteKeySha256: createHash("sha256").update(key).digest("hex"), bytes: "1" });
      await deleteShare(store, provision.id, key, t, "owner");
    }
    const set = JSON.parse((await store.get(`revoked/${provision.id}`))!.body);
    expect(set.verified.length).toBe(16);
    expect(set.verified).not.toContain(ownerHashOf(provision)); // oldest evicted
  });
});
