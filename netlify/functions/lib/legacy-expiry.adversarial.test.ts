import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import { createShare, type ShareStore, type ShareStoreEntry } from "./share-core.ts";

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
const signedBundle = async (): Promise<string> => {
  const pair = await generateSigningKeyPair();
  lastPair = pair;
  const unsigned = {
    format: "eic-share", version: 2, exportedAt: "2026-10-01T00:00:00.000Z",
    author: { id: "a", handle: "t", pubkey: encodeBase64(pair.publicKey) },
    posts: [{ id: "p1", type: "text", title: "legacy", category: "general", priceCents: null,
      description: "d", createdAt: "2026-10-01T00:00:00.000Z", likes: 0, likedBy: [], media: [], thumb: null }],
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

describe("adversarial: legacy entry without expiresAt meta", () => {
  it("idempotent retry of an UNEXPIRED legacy entry resets createdAt and silently extends the 90-day clock", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const DAY = 86400000;
    const now = new Date("2026-11-01T12:00:00.000Z");
    const provision = { id: randomBytes(12).toString("base64url"), deleteKey: randomBytes(24).toString("base64url") };
    // Seed exactly what the CURRENTLY PUBLISHED #80 code writes: no expiresAt meta.
    const originalCreated = new Date(now.getTime() - 89 * DAY).toISOString();
    await store.put(`posts/${provision.id}`, text, {
      createdAt: originalCreated,
      deleteKeySha256: createHash("sha256").update(provision.deleteKey).digest("hex"),
      bytes: String(text.length),
    });
    // Same-intent retry at day 89 (entry unexpired by createdAt).
    const retry = await createShare(store, text, now, await proofFor(text, now, provision), provision, "owner");
    expect(retry.existed).toBe(true);
    const after = await store.get(`posts/${provision.id}`);
    // NO-OP promise broken: createdAt was reset to now -> 90-day clock extended by 89 days.
    expect(after!.meta.createdAt).toBe(originalCreated); // FAILS on current code (resets to now)
  });
});
