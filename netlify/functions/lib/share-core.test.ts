import { describe, expect, it } from "vitest";
import { encodeBase64, type Item } from "@veil/core";
import { generateSigningKeyPair, signPayload, SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../../packages/vault/src/memory-store";
import { buildShareBundle } from "@veil/features";
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
  overrides: { title?: string; description?: string; photo?: boolean } = {},
): Promise<string> => {
  const pair = await generateSigningKeyPair();
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

const BASES = { relayBase: "https://eic.example", appBase: "https://eic.example" };
const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("share relay core", () => {
  it("publishes a valid signed bundle and reads it back", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const created = await createShare(store, text, NOW);
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(created.deleteKey.length).toBeGreaterThanOrEqual(32);
    const entry = await readShare(store, created.id, NOW);
    expect(entry?.body).toBe(text);
  });

  it("rejects non-JSON, wrong formats, and oversized uploads before storing", async () => {
    const store = memoryStore();
    await expect(createShare(store, "not json", NOW)).rejects.toThrow("not readable JSON");
    await expect(createShare(store, JSON.stringify({ format: "other" }), NOW)).rejects.toThrow("not an eic share");
    await expect(createShare(store, JSON.stringify({ format: "eic-share", version: 2, author: { handle: "t" }, posts: [] }), NOW)).rejects.toThrow(
      "carries one post",
    );
    // Two posts are rejected too: the page previews one post and Save must import exactly that one.
    const twoPosts = JSON.parse(await signedBundle());
    twoPosts.posts.push({ ...twoPosts.posts[0], id: "post-2" });
    const resigned = twoPosts; // shape rejection happens before the signature check
    await expect(createShare(store, JSON.stringify(resigned), NOW)).rejects.toThrow("carries one post");
    await expect(createShare(store, " ".repeat(MAX_RELAY_BUNDLE_BYTES + 1), NOW)).rejects.toThrow("too large");
    expect(store.entries.size).toBe(0);
  });

  it("rejects unsigned or tampered bundles before storing", async () => {
    const store = memoryStore();
    const text = await signedBundle();
    const raw = JSON.parse(text);
    raw.signature = encodeBase64(new Uint8Array(64)); // well-formed but invalid
    await expect(createShare(store, JSON.stringify(raw), NOW)).rejects.toThrow("not signed");
    const tampered = JSON.parse(text);
    tampered.posts[0].title = "forged title"; // signature no longer matches the payload
    await expect(createShare(store, JSON.stringify(tampered), NOW)).rejects.toThrow("not signed");
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
    const created = await createShare(store, built.text, NOW);
    const html = renderSharePage((await readShare(store, created.id, NOW))!.body, created.id, BASES);
    expect(html).toContain("Rooftop");
    expect(html).toContain("from @tester");
  });

  it("revokes only with the creator's delete key", async () => {
    const store = memoryStore();
    const created = await createShare(store, await signedBundle(), NOW);
    expect(await deleteShare(store, created.id, "wrong-key")).toBe("forbidden");
    expect(await readShare(store, created.id, NOW)).not.toBeNull();
    expect(await deleteShare(store, created.id, created.deleteKey)).toBe("deleted");
    expect(await readShare(store, created.id, NOW)).toBeNull();
    expect(await deleteShare(store, created.id, created.deleteKey)).toBe("missing");
  });

  it("expires shares past retention on read and in the sweep", async () => {
    const store = memoryStore();
    const created = await createShare(store, await signedBundle(), NOW);
    const later = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000);
    expect(await readShare(store, created.id, later)).toBeNull();
    const postKeys = () => [...store.entries.keys()].filter((key) => key.startsWith("posts/"));
    expect(postKeys()).toEqual([]);

    await createShare(store, await signedBundle(), NOW);
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
      await createShare(store, await signedBundle(), NOW, "client-a");
    }
    await expect(createShare(store, await signedBundle(), NOW, "client-a")).rejects.toThrow("Too many shares");
    // A different client is unaffected; after the window the counter resets.
    await createShare(store, await signedBundle(), NOW, "client-b");
    const later = new Date(NOW.getTime() + 61 * 60 * 1000);
    await createShare(store, await signedBundle(), later, "client-a");
  });

  it("refuses new shares when the store caps are reached", async () => {
    const store = memoryStore();
    await store.put("meta/stats", JSON.stringify({ count: 500, bytes: 0 }), {});
    await expect(createShare(store, await signedBundle(), NOW)).rejects.toThrow("full");
    await store.put("meta/stats", JSON.stringify({ count: 1, bytes: 250 * 1024 * 1024 }), {});
    await expect(createShare(store, await signedBundle(), NOW)).rejects.toThrow("full");
  });

  it("tracks live share count across publish, revoke and expiry", async () => {
    const store = memoryStore();
    const a = await createShare(store, await signedBundle(), NOW);
    const b = await createShare(store, await signedBundle(), NOW);
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(2);
    await deleteShare(store, a.id, a.deleteKey);
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(1);
    await readShare(store, b.id, new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000));
    expect(JSON.parse(store.entries.get("meta/stats")!.body).count).toBe(0);
  });
});
