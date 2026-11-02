import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64, type Item } from "@veil/core";
import { generateSigningKeyPair, signPayload, SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../../packages/vault/src/memory-store";
import { buildShareBundle, loadOrCreateShareIdentity } from "@veil/features";
import {
  MAX_RELAY_BUNDLE_BYTES,
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
  return {
    entries,
    put: async (key, body, meta) => {
      entries.set(key, { body, meta });
    },
    get: async (key) => entries.get(key) ?? null,
    delete: async (key) => {
      entries.delete(key);
    },
    list: async () => [...entries.keys()],
  };
};

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
const proofFor = async (text: string, now: Date, pair = lastPair) => {
  const at = now.toISOString();
  const digest = createHash("sha256").update(text).digest("hex");
  const signature = await signPayload(pair.secretKey, new TextEncoder().encode(`eic-share-publish:v1\n${digest}\n${at}`));
  return { signature: encodeBase64(signature), at };
};

const NO_PROOF = { signature: null, at: null };

const publish = async (store: ShareStore & { entries: Map<string, ShareStoreEntry> }, text: string, now: Date = NOW, clientKey?: string) =>
  createShare(store, text, now, await proofFor(text, now), clientKey);

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
    await expect(createShare(store, "not json", NOW, NO_PROOF)).rejects.toThrow("not readable JSON");
    await expect(createShare(store, JSON.stringify({ format: "other" }), NOW, NO_PROOF)).rejects.toThrow("not an eic share");
    await expect(createShare(store, JSON.stringify({ format: "eic-share", version: 2, author: { handle: "t" }, posts: [] }), NOW, NO_PROOF)).rejects.toThrow(
      "carries one post",
    );
    // Two posts are rejected too: the page previews one post and Save must import exactly that one.
    const twoPosts = JSON.parse(await signedBundle());
    twoPosts.posts.push({ ...twoPosts.posts[0], id: "post-2" });
    const resigned = twoPosts; // shape rejection happens before the signature check
    await expect(createShare(store, JSON.stringify(resigned), NOW, NO_PROOF)).rejects.toThrow("carries one post");
    await expect(createShare(store, " ".repeat(MAX_RELAY_BUNDLE_BYTES + 1), NOW, NO_PROOF)).rejects.toThrow("too large");
    expect(store.entries.size).toBe(0);
  });

  it("rejects unsigned or tampered bundles before storing", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const raw = JSON.parse(text);
    raw.signature = encodeBase64(new Uint8Array(64)); // well-formed but invalid
    await expect(createShare(store, JSON.stringify(raw), NOW, NO_PROOF)).rejects.toThrow("not signed");
    const tampered = JSON.parse(text);
    tampered.posts[0].title = "forged title"; // signature no longer matches the payload
    await expect(createShare(store, JSON.stringify(tampered), NOW, NO_PROOF)).rejects.toThrow("not signed");
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
    const proofAt = NOW.toISOString();
    const proofDigest = createHash("sha256").update(built.text).digest("hex");
    const proofSig = await signPayload(identity.secretKey, new TextEncoder().encode(`eic-share-publish:v1\n${proofDigest}\n${proofAt}`));
    const created = await createShare(store, built.text, NOW, { signature: encodeBase64(proofSig), at: proofAt });
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
    await expect(createShare(store, text, NOW, NO_PROOF)).rejects.toThrow("fresh signature");
    const stale = await proofFor(text, new Date(NOW.getTime() - 6 * 60 * 1000));
    await expect(createShare(store, text, NOW, stale)).rejects.toThrow("stale");
    // A proof dated past the small clock-skew allowance is rejected: the window is
    // one-sided (5 min back, 1 min ahead), not a 10-minute band around now.
    const future = await proofFor(text, new Date(NOW.getTime() + 61 * 1000));
    await expect(createShare(store, text, NOW, future)).rejects.toThrow("future");

    const pinnedPair = await generateSigningKeyPair();
    const pinned = await signedBundle({ pair: pinnedPair });
    const mismatched = await proofFor(await signedBundle(), NOW); // proof over different content
    lastPair = pinnedPair;
    const foreignProof = await proofFor(pinned, NOW, await generateSigningKeyPair());
    await expect(createShare(store, pinned, NOW, mismatched)).rejects.toThrow();
    await expect(createShare(store, pinned, NOW, foreignProof)).rejects.toThrow("does not match");
    expect(store.entries.size).toBe(0);
  });

  it("accepts a proof within the small forward clock-skew allowance", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const skewedProof = await proofFor(text, new Date(NOW.getTime() + 30 * 1000));
    const created = await createShare(store, text, NOW, skewedProof);
    expect(created.deleteKey.length).toBeGreaterThanOrEqual(32);
  });

  it("a captured bundle plus captured proof replays only inside the short window", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const created = await publish(store, text);
    expect(await deleteShare(store, created.id, created.deleteKey)).toBe("deleted");
    // Residual, documented: body + proof captured together replay within the window.
    const capturedProof = await proofFor(text, NOW);
    const replay = await createShare(store, text, NOW, capturedProof);
    expect(replay.id).not.toBe(created.id);
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);
    await expect(createShare(store, text, later, capturedProof)).rejects.toThrow("stale");
  });

  it("the author can always re-share immediately after revoke: fresh proof, fresh link and key", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const first = await publish(store, text);
    await deleteShare(store, first.id, first.deleteKey);
    const second = await publish(store, text);
    expect(second.id).not.toBe(first.id);
    expect(second.deleteKey).not.toBe(first.deleteKey);
    expect(second.deleteKey.length).toBeGreaterThanOrEqual(32);
    const entry = await readShare(store, second.id, NOW);
    expect(entry?.body).toBe(text);
  });
});
