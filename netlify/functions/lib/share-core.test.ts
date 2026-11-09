import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64, type Item } from "@veil/core";
import { generateSigningKeyPair, signPayload, SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../../packages/vault/src/memory-store";
import { buildShareBundle, loadOrCreateShareIdentity } from "@veil/features";
import {
  MAX_RELAY_BUNDLE_BYTES,
  PUBLISH_RATE_LIMIT,
  checkPublishRate,
  createShare,
  deleteShare,
  extractPhoto,
  parseSharedBundle,
  readShare,
  renderSharePage,
  sweepExpired,
  verifyShareSignature,
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
    delete: async (key) => {
      entries.delete(key);
    },
    list: async () => [...entries.keys()],
  };
};

/** Client-provisioned id (16 base64url chars) + delete key (32 base64url chars). */
const provisionFor = () => ({
  id: randomBytes(12).toString("base64url"),
  deleteKey: randomBytes(24).toString("base64url"),
});

// Fixtures are signed with a real Ed25519 key over the canonical payload (keys in the
// builder's order), because the relay refuses anything unsigned - see the parity test.
const signedBundle = async (
  overrides: { title?: string; description?: string; photo?: boolean; pair?: Awaited<ReturnType<typeof generateSigningKeyPair>> } = {},
): Promise<string> => {
  const pair = overrides.pair ?? (await generateSigningKeyPair());
  lastPair = pair;
  const unsigned = {
    format: "eic-share",
    version: 2,
    exportedAt: "2026-11-01T00:00:00.000Z",
    author: { id: "author-1", handle: "tester", pubkey: encodeBase64(pair.publicKey) },
    posts: [
      {
        id: "post-1",
        type: "photo",
        title: overrides.title ?? "A tiny post",
        category: "general",
        priceCents: null,
        description: overrides.description ?? "seeded by unit tests",
        createdAt: "2026-11-01T00:00:00.000Z",
        likes: 0,
        likedBy: [],
        media: overrides.photo === false ? [] : [{ mime: "image/png", data: TINY_PNG_B64 }],
        thumb: null,
      },
    ],
    likes: [],
    likesComplete: false,
  };
  const signature = await signPayload(pair.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  return JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
};

/** Mirrors apps/web/app/platform/share-relay.ts buildPublishProof field-for-field. */
const proofFor = async (text: string, now: Date, provision: { id: string; deleteKey: string }, pair = lastPair) => {
  const at = now.toISOString();
  const digest = createHash("sha256").update(text).digest("hex");
  const keyDigest = createHash("sha256").update(provision.deleteKey).digest("hex");
  const signature = await signPayload(pair.secretKey, new TextEncoder().encode(`eic-share-publish:v1\n${digest}\n${at}\n${provision.id}\n${keyDigest}`));
  return { signature: encodeBase64(signature), at, id: provision.id };
};

const NO_PROOF = { signature: null, at: null, id: null };

const publish = async (
  store: ShareStore & { entries: Map<string, ShareStoreEntry> },
  text: string,
  now: Date = NOW,
  clientKey?: string,
  provision = provisionFor(),
) => createShare(store, text, now, await proofFor(text, now, provision), provision, clientKey);

const BASES = { relayBase: "https://eic.example", appBase: "https://eic.example" };
const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("share relay core", () => {
  it("publishes a valid signed bundle and reads it back", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const created = await publish(store, text);
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(created.deleteKey.length).toBeGreaterThanOrEqual(32);
    const entry = await readShare(store, created.id, NOW);
    expect(entry?.body).toBe(text);
  });

  it("rejects non-JSON, wrong formats, and oversized uploads before storing", async () => {
    const store = memoryStore();
    const provision = provisionFor();
    await expect(createShare(store, "not json", NOW, NO_PROOF, provision)).rejects.toThrow("not readable JSON");
    await expect(createShare(store, JSON.stringify({ format: "other" }), NOW, NO_PROOF, provision)).rejects.toThrow("not an eic share");
    await expect(createShare(store, JSON.stringify({ format: "eic-share", version: 2, author: { handle: "t" }, posts: [] }), NOW, NO_PROOF, provision)).rejects.toThrow(
      "carries one post",
    );
    // Two posts are rejected too: the page previews one post and Save must import exactly that one.
    const twoPosts = JSON.parse(await signedBundle());
    twoPosts.posts.push({ ...twoPosts.posts[0], id: "post-2" });
    const resigned = twoPosts; // shape rejection happens before the signature check
    await expect(createShare(store, JSON.stringify(resigned), NOW, NO_PROOF, provision)).rejects.toThrow("carries one post");
    await expect(createShare(store, " ".repeat(MAX_RELAY_BUNDLE_BYTES + 1), NOW, NO_PROOF, provision)).rejects.toThrow("too large");
    // Malformed client-provisioned ids/keys are rejected before anything is stored.
    await expect(createShare(store, "not json", NOW, NO_PROOF, { id: "short", deleteKey: provision.deleteKey })).rejects.toThrow("link id is malformed");
    await expect(createShare(store, "not json", NOW, NO_PROOF, { id: provision.id, deleteKey: "too-short" })).rejects.toThrow("delete key is malformed");
    expect(store.entries.size).toBe(0);
  });

  it("rejects unsigned or tampered bundles before storing", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const raw = JSON.parse(text);
    raw.signature = encodeBase64(new Uint8Array(64)); // well-formed but invalid
    await expect(createShare(store, JSON.stringify(raw), NOW, NO_PROOF, provisionFor())).rejects.toThrow("not signed");
    const tampered = JSON.parse(text);
    tampered.posts[0].title = "forged title"; // signature no longer matches the payload
    await expect(createShare(store, JSON.stringify(tampered), NOW, NO_PROOF, provisionFor())).rejects.toThrow("not signed");
    expect(store.entries.size).toBe(0);
    expect(await verifyShareSignature(text)).toBe(true);
    expect(await verifyShareSignature(JSON.stringify(tampered))).toBe(false);
  });

  it("byte-parity: accepts a real bundle produced by the app's buildShareBundle", async () => {
    const vault = await createVault(
      { store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW },
      "pass phrase 1",
    );
    const settings = { authorId: "author-1", handle: "tester" } as never;
    const item: Item = {
      id: "i1", type: "photo", title: "Rooftop", category: "general", priceCents: null,
      description: "from the real builder", createdAt: "2026-10-31T00:00:00.000Z", likes: 0,
      mediaIds: [], thumbId: null, mediaMime: "image/webp", visibility: "private",
      authorId: null, authorHandle: null, likedByMe: false, likedBy: [], schemaVersion: 1,
    };
    const built = await buildShareBundle(vault, settings, [item], NOW, { onlyPostId: "i1" });
    expect(await verifyShareSignature(built.text)).toBe(true);
    const store = memoryStore();
    const identity = await loadOrCreateShareIdentity(vault);
    const provision = provisionFor();
    const proofAt = NOW.toISOString();
    const proofDigest = createHash("sha256").update(built.text).digest("hex");
    const keyDigest = createHash("sha256").update(provision.deleteKey).digest("hex");
    const proofSig = await signPayload(
      identity.secretKey,
      new TextEncoder().encode(`eic-share-publish:v1\n${proofDigest}\n${proofAt}\n${provision.id}\n${keyDigest}`),
    );
    const created = await createShare(store, built.text, NOW, { signature: encodeBase64(proofSig), at: proofAt, id: provision.id }, provision);
    const html = renderSharePage((await readShare(store, created.id, NOW))!.body, created.id, BASES);
    expect(html).toContain("Rooftop");
    expect(html).toContain("from @tester");
  });

  it("revokes only with the creator's delete key", async () => {
    const store = memoryStore();
    const created = await publish(store, await signedBundle());
    expect(await deleteShare(store, created.id, "wrong-key")).toBe("forbidden");
    expect(await readShare(store, created.id, NOW)).not.toBeNull();
    expect(await deleteShare(store, created.id, created.deleteKey)).toBe("deleted");
    expect(await readShare(store, created.id, NOW)).toBeNull();
    expect(await deleteShare(store, created.id, created.deleteKey)).toBe("missing");
  });

  it("expires shares past retention on read and in the sweep", async () => {
    const store = memoryStore();
    const created = await publish(store, await signedBundle());
    const later = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000);
    expect(await readShare(store, created.id, later)).toBeNull();
    const postKeys = () => [...store.entries.keys()].filter((key) => key.startsWith("posts/"));
    expect(postKeys()).toEqual([]);

    await publish(store, await signedBundle());
    expect(await sweepExpired(store, later)).toBe(1);
    expect(postKeys()).toEqual([]);
    // Stats reconcile: nothing counted as live after expiry.
    const stats = JSON.parse(store.entries.get("meta/stats")!.body);
    expect(stats.count).toBe(0);
  });

  it("renders the post with its photo and escapes markup in every field", async () => {
    const html = renderSharePage(
      await signedBundle({ title: '<script>alert("x")</script>', description: 'desc <b>bold</b> "quoted"' }),
      "abc123def456",
      BASES,
    );
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("desc &lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;");
    expect(html).toContain('property="og:image" content="https://eic.example/s/abc123def456/photo"');
    // Browsers jump straight to the app's read-only view; the no-JS fallback links there too.
    expect(html).toContain('location.replace("https://eic.example/shared/abc123def456")');
    expect(html).toContain('href="https://eic.example/shared/abc123def456"');
    expect(html).toContain("from @tester");
  });

  it("omits og:image for text-only posts", async () => {
    const html = renderSharePage(await signedBundle({ photo: false }), "abc123def456", BASES);
    expect(html).not.toContain("og:image");
    expect(html).toContain('property="og:title"');
  });

  it("extracts the first photo for og:image and the page", async () => {
    const photo = extractPhoto(await signedBundle());
    expect(photo?.mime).toBe("image/png");
    expect(photo?.bytes.equals(Buffer.from(TINY_PNG_B64, "base64"))).toBe(true);
    expect(extractPhoto(await signedBundle({ photo: false }))).toBeNull();
  });

  it("accepts the real share bundle shape from the app builder", async () => {
    const parsed = parseSharedBundle(await signedBundle());
    expect(parsed.authorHandle).toBe("tester");
    expect(parsed.posts[0].title).toBe("A tiny post");
  });
});

describe("share relay abuse bounds", () => {
  it("rate-limits publishes per client and resets after the window", async () => {
    const store = memoryStore();
    for (let i = 0; i < 10; i += 1) {
      await publish(store, await signedBundle(), NOW, "client-a");
    }
    await expect(publish(store, await signedBundle(), NOW, "client-a")).rejects.toThrow("Too many shares");
    // A different client is unaffected; after the window the counter resets.
    await publish(store, await signedBundle(), NOW, "client-b");
    const later = new Date(NOW.getTime() + 61 * 60 * 1000);
    await publish(store, await signedBundle(), later, "client-a");
  });

  it("refuses new shares when the store caps are reached", async () => {
    const store = memoryStore();
    // Count cap is exact and self-healing: an inflated stats blob does not block
    // publishing when the listing is actually empty.
    await store.put("meta/stats", JSON.stringify({ count: 500, bytes: 0 }), {});
    const despiteBadStats = await publish(store, await signedBundle());
    expect(despiteBadStats.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Fill the listing to the cap and publishing really is refused.
    for (let i = 0; i < 500; i += 1) {
      await store.put(`posts/filler-${i}`, "x", { createdAt: NOW.toISOString() });
    }
    await expect(publish(store, await signedBundle())).rejects.toThrow("full");
    // Byte cap still comes from the incremental stats blob (list() has no sizes).
    const store2 = memoryStore();
    await store2.put("meta/stats", JSON.stringify({ count: 1, bytes: 250 * 1024 * 1024 }), {});
    await expect(publish(store2, await signedBundle())).rejects.toThrow("full");
  });

  it("tracks live share count across publish, revoke and expiry", async () => {
    const store = memoryStore();
    const a = await publish(store, await signedBundle());
    const b = await publish(store, await signedBundle());
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(2);
    await deleteShare(store, a.id, a.deleteKey);
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(1);
    await readShare(store, b.id, new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000));
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(0);
  });
});

describe("share relay fresh-owner-intent proof", () => {
  it("rejects a publish with no proof, a stale proof, a wrong digest, or a foreign key", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    await expect(createShare(store, text, NOW, NO_PROOF, provision)).rejects.toThrow("fresh signature");
    const stale = await proofFor(text, new Date(NOW.getTime() - 6 * 60 * 1000), provision);
    await expect(createShare(store, text, NOW, stale, provision)).rejects.toThrow("stale");
    // A proof dated past the small clock-skew allowance is rejected: the window is
    // one-sided (5 min back, 1 min ahead), not a 10-minute band around now.
    const future = await proofFor(text, new Date(NOW.getTime() + 61 * 1000), provision);
    await expect(createShare(store, text, NOW, future, provision)).rejects.toThrow("future");
    // A proof for a different id or a different delete key fails verification, so a
    // captured request with a substituted id or keyHash is rejected, not accepted.
    const other = provisionFor();
    await expect(createShare(store, text, NOW, await proofFor(text, NOW, provision), other)).rejects.toThrow("does not match");
    await expect(
      createShare(store, text, NOW, await proofFor(text, NOW, { ...provision, deleteKey: other.deleteKey }), provision),
    ).rejects.toThrow("does not match");
    await expect(createShare(store, text, NOW, { ...(await proofFor(text, NOW, provision)), id: other.id }, other)).rejects.toThrow(
      "does not match",
    );

    const pinnedPair = await generateSigningKeyPair();
    const pinned = await signedBundle({ pair: pinnedPair });
    const mismatched = await proofFor(await signedBundle(), NOW, provision); // proof over different content
    lastPair = pinnedPair;
    const foreignProof = await proofFor(pinned, NOW, provision, await generateSigningKeyPair());
    await expect(createShare(store, pinned, NOW, mismatched, provision)).rejects.toThrow();
    await expect(createShare(store, pinned, NOW, foreignProof, provision)).rejects.toThrow("does not match");
    expect(store.entries.size).toBe(0);
  });

  it("accepts a proof within the small forward clock-skew allowance", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    const skewedProof = await proofFor(text, new Date(NOW.getTime() + 30 * 1000), provision);
    const created = await createShare(store, text, NOW, skewedProof, provision);
    expect(created.deleteKey.length).toBeGreaterThanOrEqual(32);
  });

  it("lost response after commit: retrying the same intent is an idempotent no-op", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    const first = await publish(store, text, NOW, undefined, provision);
    expect(first.existed).toBe(false);
    // Same id + same bytes with a fresh proof: the publish had already committed, so
    // the retry returns the committed share and never double-counts.
    const retry = await publish(store, text, new Date(NOW.getTime() + 60 * 1000), undefined, provision);
    expect(retry.existed).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(retry.deleteKey).toBe(first.deleteKey);
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(1);
    // An UNEXPIRED legacy entry (createdAt-based expiry, no expiresAt meta) retries as
    // a true no-op: createdAt is NOT reset and the 90-day clock is not extended.
    const legacyStore = memoryStore();
    const legacyCreated = new Date(NOW.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
    await legacyStore.put(`posts/${provision.id}`, text, {
      createdAt: legacyCreated,
      deleteKeySha256: createHash("sha256").update(provision.deleteKey).digest("hex"),
      bytes: String(text.length),
    });
    const legacyRetry = await publish(legacyStore, text, NOW, undefined, provision);
    expect(legacyRetry.existed).toBe(true);
    expect(legacyStore.entries.get(`posts/${provision.id}`)!.meta.createdAt).toBe(legacyCreated);
    // An EXPIRED same-id retry is refused, never silently renewed: a re-share is an
    // explicit new intent with a new id.
    const later = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000);
    await expect(publish(store, text, later, undefined, provision)).rejects.toThrow("expired");
    // Same id with different bytes is a conflict, never an overwrite.
    await expect(publish(store, await signedBundle({ title: "different" }), NOW, undefined, provision)).rejects.toThrow("already used for different content");
  });

  it("a captured bundle plus captured proof replays only inside the short window", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    const created = await publish(store, text, NOW, undefined, provision);
    // Inside the window a replay resolves to the same committed share (no-op).
    const capturedProof = await proofFor(text, NOW, provision);
    const replay = await createShare(store, text, NOW, capturedProof, provision);
    expect(replay.id).toBe(created.id);
    expect(replay.existed).toBe(true);
    // After the window the captured proof is stale and rejected.
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);
    await expect(createShare(store, text, later, capturedProof, provision)).rejects.toThrow("stale");
  });

  it("a delayed create after revoke is blocked by the marker; a fresh id re-shares immediately", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    const first = await publish(store, text, NOW, undefined, provision);
    expect(await deleteShare(store, first.id, first.deleteKey, NOW)).toBe("deleted");
    // Delayed retry of the REVOKED intent within the marker TTL: blocked, no resurrect.
    await expect(publish(store, text, new Date(NOW.getTime() + 60 * 1000), undefined, provision)).rejects.toThrow("revoked");
    expect([...store.entries.keys()].filter((key) => key.startsWith("posts/"))).toEqual([]);
    // A fresh intent (fresh id + key) re-shares the same content immediately.
    const second = await publish(store, text, new Date(NOW.getTime() + 60 * 1000));
    expect(second.id).not.toBe(first.id);
    expect((await readShare(store, second.id, NOW))?.body).toBe(text);
    // Residual, documented: after the marker TTL a client that still retains the
    // revoked intent (e.g. an unsynced second device) can re-create the same id with a
    // fresh proof; no third party can, because it cannot mint one.
    const pastMarker = new Date(NOW.getTime() + 16 * 60 * 1000);
    const resurrected = await publish(store, text, pastMarker, undefined, provision);
    expect(resurrected.id).toBe(first.id);
  });

  it("a revoke racing an in-flight create still wins: the create undoes itself", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    // Simulate the interleaving: the create's atomic put lands, then the revoke's
    // marker lands before the create's post-put marker recheck.
    const originalPut = store.put.bind(store);
    store.put = async (key, body, meta, condition) => {
      const result = await originalPut(key, body, meta, condition);
      if (result.modified && key.startsWith("posts/")) {
        await originalPut(
          `revoked/${key.slice("posts/".length)}`,
          JSON.stringify({ verified: [createHash("sha256").update(provision.deleteKey).digest("hex")], unverified: [] }),
          { deletedAt: NOW.toISOString() },
        );
      }
      return result;
    };
    await expect(publish(store, text, NOW, undefined, provision)).rejects.toThrow("revoked");
    expect([...store.entries.keys()].filter((key) => key.startsWith("posts/"))).toEqual([]);
  });

  it("a revoke of an absent id blocks a delayed create with the same key but never a different key", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    // Revoke arrives before any create (the publish response was lost AND the entry
    // never committed): the marker is keyed by the presented key's hash.
    expect(await deleteShare(store, provision.id, provision.deleteKey, NOW)).toBe("missing");
    await expect(publish(store, text, NOW, undefined, provision)).rejects.toThrow("revoked");
    // No arbitrary-id denial: a marker written with a WRONG key does not block the
    // legitimate publisher, whose create presents a different key hash.
    const other = provisionFor();
    expect(await deleteShare(store, other.id, "a-wrong-key-that-is-long-enough-32chars", NOW)).toBe("missing");
    const created = await publish(store, text, NOW, undefined, other);
    expect(created.id).toBe(other.id);
  });

  it("a wrong-key delete cannot clobber the legitimate revoke marker", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const provision = provisionFor();
    const first = await publish(store, text, NOW, undefined, provision);
    // The owner revokes (existing post: the verified key's hash is marked).
    expect(await deleteShare(store, first.id, first.deleteKey, NOW)).toBe("deleted");
    // A wrong-key delete of the SAME absent id arrives after: the merge must keep the
    // legitimate hash, so the owner's delayed create stays blocked.
    expect(await deleteShare(store, first.id, "a-wrong-key-that-is-long-enough-32chars", NOW, "client-b")).toBe("missing");
    await expect(publish(store, text, new Date(NOW.getTime() + 60 * 1000), undefined, provision)).rejects.toThrow("revoked");
    expect([...store.entries.keys()].filter((key) => key.startsWith("posts/"))).toEqual([]);
  });

  it("absent-id deletes are rate-limited per client like publishes", async () => {
    const store = memoryStore();
    const id = "some-absent-id-1";
    for (let i = 0; i < 10; i += 1) {
      expect(await deleteShare(store, id, `junk-key-${i}-pad-pad-pad-pad-pad-pad`, NOW, "client-a")).toBe("missing");
    }
    await expect(deleteShare(store, id, "junk-key-final-pad-pad-pad-pad-pad", NOW, "client-a")).rejects.toThrow("Too many");
  });
});


it("does not lose concurrent rate claims for one client", async () => {
  const store = memoryStore();
  const results = await Promise.allSettled(Array.from({ length: PUBLISH_RATE_LIMIT + 5 }, () => checkPublishRate(store, "same-client", NOW)));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  expect(accepted).toBeLessThanOrEqual(PUBLISH_RATE_LIMIT);
  expect(accepted).toBeGreaterThan(0);
});
it("fails closed when a stored rate counter has no conditional-update token", async () => {
  const store = memoryStore();
  await checkPublishRate(store, "no-etag", NOW);
  for (const [key, entry] of store.entries) if (key.startsWith("rl/")) delete entry.etag;
  await expect(checkPublishRate(store, "no-etag", NOW)).rejects.toMatchObject({ status: 503 });
});
