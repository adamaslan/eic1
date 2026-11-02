import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import {
  createShare,
  deleteShare,
  readShare,
  type ShareStore,
  type ShareStoreEntry,
} from "./share-core.ts";

let lastPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

const provisionFor = () => ({
  id: randomBytes(12).toString("base64url"),
  deleteKey: randomBytes(24).toString("base64url"),
});

const signedBundle = async (): Promise<string> => {
  const pair = await generateSigningKeyPair();
  lastPair = pair;
  const unsigned = {
    format: "eic-share", version: 2, exportedAt: "2026-11-01T00:00:00.000Z",
    author: { id: "author-1", handle: "tester", pubkey: encodeBase64(pair.publicKey) },
    posts: [{ id: "post-1", type: "photo", title: "sat", category: "general", priceCents: null,
      description: "sat", createdAt: "2026-11-01T00:00:00.000Z", likes: 0, likedBy: [],
      media: [{ mime: "image/png", data: TINY_PNG_B64 }], thumb: null }],
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
const DAY = 24 * 60 * 60 * 1000;

describe("adversarial: marker saturation", () => {
  it("junk flooding an absent-id window cannot block the owner's later revoke: junk self-resets each window, the verified revoke always lands, and a post-revoke in-flight create stays blocked", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();

    // 1. Owner publishes (recipient learns the id).
    await createShare(store, text, T0, await proofFor(text, T0, provision), provision, "owner");

    // 2. Entry expires at 90d; a recipient's read lazy-deletes it. Id now KNOWN and ABSENT.
    const t91 = new Date(T0.getTime() + 91 * DAY);
    expect(await readShare(store, provision.id, t91)).toBeNull();

    // 3. Attacker floods absent-id deletes with junk keys (10/hr/IP; use 7 IPs ~ 1h).
    //    Junk lands only in the capped UNVERIFIED set, and junk writes never extend the
    //    window: at 1/min spacing the set self-resets every TTL window, so a slow flood
    //    can never accumulate the full 64 or keep the marker alive indefinitely.
    for (let i = 0; i < 64; i += 1) {
      const t = new Date(t91.getTime() + i * 60 * 1000);
      await deleteShare(store, provision.id, randomBytes(24).toString("base64url"), t, `attacker-ip-${i % 7}`);
    }
    const saturated = await store.get(`revoked/${provision.id}`);
    expect(saturated).not.toBeNull();
    // Last reset at minute 48 -> only minutes 48..63 survive; deletedAt is the window
    // start, not the latest junk write (junk cannot extend the window).
    expect(JSON.parse(saturated!.body).unverified.length).toBe(16);
    expect(saturated!.meta.deletedAt).toBe(new Date(t91.getTime() + 48 * 60 * 1000).toISOString());

    // 4. Owner's unsynced device re-publishes (fresh proof) - documented residual: commits.
    const t92 = new Date(t91.getTime() + 2 * 60 * 60 * 1000);
    const repub = await createShare(store, text, t92, await proofFor(text, t92, provision), provision, "owner");
    expect(repub.existed).toBe(false);

    // 5. Owner revokes (correct key, entry present). The key-checked hash lands in the
    //    marker's VERIFIED set, which junk saturation can never evict.
    const t93 = new Date(t92.getTime() + 60 * 1000);
    const outcome = await deleteShare(store, provision.id, provision.deleteKey, t93, "owner");
    expect(outcome).toBe("deleted");
    const after = await store.get(`revoked/${provision.id}`);
    const ownerHash = createHash("sha256").update(provision.deleteKey).digest("hex");
    expect(JSON.parse(after!.body).verified).toContain(ownerHash); // legit revoke hash always recorded

    // 6. A second in-flight create of the same intent (validated before the revoke) is
    //    still blocked: the verified marker survived the junk flood. NO resurrection.
    const t94 = new Date(t93.getTime() + 30 * 1000);
    await expect(createShare(store, text, t94, await proofFor(text, t93, provision), provision, "owner")).rejects.toThrow("revoked");
    expect(await readShare(store, provision.id, t94)).toBeNull();
  });

  it("without saturation the same interleaving is blocked by the marker (control)", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    await createShare(store, text, T0, await proofFor(text, T0, provision), provision, "owner");
    const t91 = new Date(T0.getTime() + 91 * DAY);
    await readShare(store, provision.id, t91);
    const t92 = new Date(t91.getTime() + 2 * 60 * 60 * 1000);
    await createShare(store, text, t92, await proofFor(text, t92, provision), provision, "owner");
    const t93 = new Date(t92.getTime() + 60 * 1000);
    await deleteShare(store, provision.id, provision.deleteKey, t93, "owner");
    const t94 = new Date(t93.getTime() + 30 * 1000);
    await expect(createShare(store, text, t94, await proofFor(text, t93, provision), provision, "owner")).rejects.toThrow("revoked");
  });
});
