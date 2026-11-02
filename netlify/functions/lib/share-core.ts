/**
 * eic share relay - runtime-agnostic core.
 *
 * One explicitly shared post, readable by anyone holding the link. Pressing Share on a
 * post is the consent; the upload is exactly the single-post signed bundle the share
 * file path already produces - nothing else from the vault ever leaves the device.
 * The page this module renders is what iMessage shows as the link preview and what the
 * recipient sees on tap; "Open in eic" deep-links the app, which fetches the bundle
 * back and offers the same explicit import as every other share path.
 *
 * The relay verifies the bundle's Ed25519 signature at publish time (same Web Crypto
 * primitive as the app), so stored/rendered content is always signed by the key it
 * claims - a signer can still choose any handle, but unsigned or tampered content can
 * never become a share page or message card. Import re-verifies client-side as before.
 * - shape: a single-post eic-share v2 projection, so a share can never smuggle a vault
 * - size: MAX_RELAY_BUNDLE_BYTES
 * - escaping: every rendered field is HTML-escaped
 * - retention (proposed config, not an owner-set preference): entries carry createdAt;
 *   a read that finds an EXPIRED entry deletes it on sight (ordinary reads are never
 *   destructive); sweepExpired is available for a later, separately-decided cron
 * - revocation: the creator alone gets a delete key at publish; presenting it deletes
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_RELAY_BUNDLE_BYTES = 4 * 1024 * 1024;
export const SHARE_RETENTION_DAYS = 90;
// Abuse bounds (proposed config). Approximate by design: the blob store has no
// compare-and-swap, so concurrent writers can drift these slightly - they exist to stop
// bulk abuse, not to be exact accounting.
export const MAX_SHARE_COUNT = 500;
export const MAX_SHARE_STORE_BYTES = 250 * 1024 * 1024;
export const PUBLISH_RATE_LIMIT = 10; // publishes per client per window
export const PUBLISH_RATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 5000;
const MAX_HANDLE_CHARS = 64;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export class ShareError extends Error {
  status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
  }
}

export interface ShareStoreEntry {
  body: string;
  meta: Record<string, string>;
}

export interface ShareStore {
  put(key: string, body: string, meta: Record<string, string>): Promise<void>;
  get(key: string): Promise<ShareStoreEntry | null>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

const keyFor = (id: string) => `posts/${id}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBase64 = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

interface PhotoRef {
  mime: string;
  data: string;
}

interface SharedPost {
  id: string;
  title: string;
  description: string;
  category: string;
  priceCents: number | null;
  createdAt: string;
  photo: PhotoRef | null;
}

export interface ParsedShare {
  authorHandle: string;
  posts: SharedPost[];
}

/** Structural check only - the recipient's app remains the signature verifier. */
export function parseSharedBundle(text: string): ParsedShare {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ShareError("That share is not readable JSON.");
  }
  if (!isRecord(raw) || raw.format !== "eic-share" || raw.version !== 2) {
    throw new ShareError("That is not an eic share.");
  }
  if (!isRecord(raw.author) || typeof raw.author.handle !== "string" || raw.author.handle.length === 0) {
    throw new ShareError("That share is missing its author.");
  }
  if (raw.author.handle.length > MAX_HANDLE_CHARS) throw new ShareError("That share is not valid.");
  // Exactly one post: the page previews one post and Save imports exactly what was read.
  if (!Array.isArray(raw.posts) || raw.posts.length !== 1) {
    throw new ShareError("A shared link carries one post.");
  }
  const posts = raw.posts.map((entry: unknown): SharedPost => {
    if (!isRecord(entry) || typeof entry.title !== "string" || entry.title.length === 0) {
      throw new ShareError("That share is missing its post.");
    }
    if (entry.title.length > MAX_TITLE_CHARS) throw new ShareError("That share is not valid.");
    if (typeof entry.description !== "string" || entry.description.length > MAX_DESCRIPTION_CHARS) {
      throw new ShareError("That share is not valid.");
    }
    if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) {
      throw new ShareError("That share is not valid.");
    }
    const media = Array.isArray(entry.media) ? entry.media : [];
    let photo: PhotoRef | null = null;
    for (const item of media) {
      if (isRecord(item) && typeof item.mime === "string" && PHOTO_MIMES.has(item.mime) && isBase64(item.data)) {
        photo = { mime: item.mime, data: item.data };
        break;
      }
    }
    if (!photo && isRecord(entry.thumb) && typeof entry.thumb.mime === "string" && PHOTO_MIMES.has(entry.thumb.mime) && isBase64(entry.thumb.data)) {
      photo = { mime: entry.thumb.mime, data: entry.thumb.data };
    }
    if (photo && Buffer.byteLength(photo.data, "base64") > MAX_PHOTO_BYTES) {
      throw new ShareError("That photo is too large to share as a link.");
    }
    return {
      id: typeof entry.id === "string" ? entry.id : "",
      title: entry.title,
      description: entry.description,
      category: typeof entry.category === "string" ? entry.category : "",
      priceCents: typeof entry.priceCents === "number" && Number.isFinite(entry.priceCents) ? Math.round(entry.priceCents) : null,
      createdAt: entry.createdAt,
      photo,
    };
  });
  return { authorHandle: raw.author.handle, posts };
}

const STATS_KEY = "meta/stats";

interface ShareStats {
  count: number;
  bytes: number;
}

const readStats = async (store: ShareStore): Promise<ShareStats> => {
  const entry = await store.get(STATS_KEY);
  if (!entry) return { count: 0, bytes: 0 };
  try {
    const parsed = JSON.parse(entry.body) as Partial<ShareStats>;
    return {
      count: typeof parsed.count === "number" && parsed.count >= 0 ? parsed.count : 0,
      bytes: typeof parsed.bytes === "number" && parsed.bytes >= 0 ? parsed.bytes : 0,
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
};

const writeStats = (store: ShareStore, stats: ShareStats): Promise<void> =>
  store.put(STATS_KEY, JSON.stringify(stats), {});

const rateKeyFor = (clientKey: string) => `rl/${createHash("sha256").update(clientKey).digest("hex").slice(0, 24)}`;

/** Fixed-window per-client publish limit. clientKey is a transport identifier (IP). */
export async function checkPublishRate(store: ShareStore, clientKey: string, now: Date): Promise<void> {
  const key = rateKeyFor(clientKey);
  const entry = await store.get(key);
  let windowStart = now.getTime();
  let count = 0;
  if (entry) {
    try {
      const parsed = JSON.parse(entry.body) as { start?: unknown; count?: unknown };
      if (typeof parsed.start === "number" && typeof parsed.count === "number" && now.getTime() - parsed.start < PUBLISH_RATE_WINDOW_MS) {
        windowStart = parsed.start;
        count = parsed.count;
      }
    } catch {
      // damaged counter: start a fresh window
    }
  }
  if (count >= PUBLISH_RATE_LIMIT) {
    throw new ShareError("Too many shares from this connection. Try again later.", 429);
  }
  await store.put(key, JSON.stringify({ start: windowStart, count: count + 1 }), {});
}

const b64ToBytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));

/**
 * Rebuilds the exact signed payload: buildShareBundle signs JSON.stringify of the bundle
 * minus `signature`, with keys in schema order. Mirrored here field-for-field; the test
 * suite proves byte-parity against real builder output.
 */
const canonicalPayload = (raw: Record<string, unknown>): string => {
  const author = raw.author as Record<string, unknown>;
  const canonicalAuthor: Record<string, unknown> = { id: author.id, handle: author.handle, pubkey: author.pubkey };
  if (typeof author.feedUrl === "string") canonicalAuthor.feedUrl = author.feedUrl;
  const posts = (raw.posts as Record<string, unknown>[]).map((post) => ({
    id: post.id,
    type: post.type,
    title: post.title,
    category: post.category,
    priceCents: post.priceCents ?? null,
    description: post.description,
    createdAt: post.createdAt,
    likes: post.likes,
    likedBy: post.likedBy ?? [],
    media: ((post.media as Record<string, unknown>[]) ?? []).map((media) => ({ mime: media.mime, data: media.data })),
    thumb: post.thumb
      ? { mime: (post.thumb as Record<string, unknown>).mime, data: (post.thumb as Record<string, unknown>).data }
      : null,
  }));
  const likes = ((raw.likes as Record<string, unknown>[]) ?? []).map((like) => ({ ownerId: like.ownerId, postId: like.postId }));
  const canonical: Record<string, unknown> = {
    format: raw.format,
    version: raw.version,
    exportedAt: raw.exportedAt,
    author: canonicalAuthor,
    posts,
    likes,
  };
  if (typeof raw.likesComplete === "boolean") canonical.likesComplete = raw.likesComplete;
  return JSON.stringify(canonical);
};

/** Ed25519 verification of a raw bundle's signature over its canonical payload. */
export async function verifyShareSignature(text: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(raw) || !isRecord(raw.author)) return false;
  if (typeof raw.author.pubkey !== "string" || typeof raw.signature !== "string") return false;
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", b64ToBytes(raw.author.pubkey), { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64ToBytes(raw.signature) as BufferSource,
      new TextEncoder().encode(canonicalPayload(raw)),
    );
  } catch {
    return false;
  }
}

export interface PublishProof {
  signature: string | null;
  at: string | null;
}

/** Maximum age of a publish proof. */
export const PUBLISH_PROOF_WINDOW_MS = 5 * 60 * 1000;
/** Small future allowance for client clock skew only - NOT a second validity window. */
export const PUBLISH_PROOF_FUTURE_SKEW_MS = 60 * 1000;

/**
 * Fresh-owner-intent proof: every publish must carry a fresh Ed25519 signature from the
 * bundle author's key over "eic-share-publish:v1\n<sha256hex(bundle)>\n<timestamp>".
 * The bundle itself is long-lived signed content anyone can copy; this proof is what a
 * captured bundle can never mint, so replayed files can never be published or
 * resurrected, while the real author can always re-share (fresh id + delete key each
 * time - no lockout, no dedupe oracle). Residual hole, documented: a body + proof
 * captured together can be replayed inside the 5-minute window; treat shares as bearer
 * content during that window.
 */
export async function verifyPublishProof(body: string, proof: PublishProof, now: Date): Promise<void> {
  if (!proof.signature || !proof.at) {
    throw new ShareError("Sharing needs a fresh signature from the author's device.", 401);
  }
  const atMs = Date.parse(proof.at);
  const age = now.getTime() - atMs;
  if (Number.isNaN(atMs) || age > PUBLISH_PROOF_WINDOW_MS) {
    throw new ShareError("That share signature is stale - share the post again.", 401);
  }
  if (age < -PUBLISH_PROOF_FUTURE_SKEW_MS) {
    throw new ShareError("That share signature is dated in the future - check the device clock and share again.", 401);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ShareError("That share is not readable JSON.");
  }
  const pubkey = isRecord(raw) && isRecord(raw.author) && typeof raw.author.pubkey === "string" ? raw.author.pubkey : null;
  if (!pubkey) throw new ShareError("That share is missing its author.");
  const digest = createHash("sha256").update(body).digest("hex");
  const payload = new TextEncoder().encode(`eic-share-publish:v1
${digest}
${proof.at}`);
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", b64ToBytes(pubkey), { name: "Ed25519" }, false, ["verify"]);
    const ok = await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(proof.signature) as BufferSource, payload);
    if (!ok) throw new ShareError("That share signature does not match this post.", 403);
  } catch (caught) {
    if (caught instanceof ShareError) throw caught;
    throw new ShareError("That share signature could not be verified.", 403);
  }
}

export async function createShare(
  store: ShareStore,
  body: string,
  now: Date,
  proof: PublishProof,
  clientKey?: string,
): Promise<{ id: string; deleteKey: string; expiresAt: string }> {
  if (clientKey) await checkPublishRate(store, clientKey, now);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_RELAY_BUNDLE_BYTES) {
    throw new ShareError("That post is too large to share as a link.", 413);
  }
  parseSharedBundle(body); // validate before storing; the stored bytes are the raw bundle
  // Nothing unsigned or tampered becomes a share page or a message card.
  if (!(await verifyShareSignature(body))) {
    throw new ShareError("That share is not signed by its author.");
  }
  await verifyPublishProof(body, proof, now);
  // Count is derived live from the listing (self-healing); bytes stay incremental and
  // are reconciled by sweepExpired, because list() exposes no sizes in blobs v11. There
  // is NO hard bound: the store has no compare-and-swap, so concurrent in-flight
  // publishes can all pass this check, and the publish rate limit is equally racy.
  // These caps stop bulk abuse in the expected case; they are not a budget guarantee.
  const count = (await store.list()).filter((key) => key.startsWith("posts/")).length;
  const stats = await readStats(store);
  if (count >= MAX_SHARE_COUNT || stats.bytes + bodyBytes > MAX_SHARE_STORE_BYTES) {
    throw new ShareError("The share service is full right now. Try again later.", 503);
  }
  const id = randomBytes(12).toString("base64url");
  const deleteKey = randomBytes(24).toString("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await store.put(keyFor(id), body, {
    createdAt,
    deleteKeySha256: createHash("sha256").update(deleteKey).digest("hex"),
    bytes: String(bodyBytes),
  });
  await writeStats(store, { count: count + 1, bytes: stats.bytes + bodyBytes });
  return { id, deleteKey, expiresAt };
}

const isExpired = (entry: ShareStoreEntry, now: Date): boolean => {
  const createdAt = Date.parse(entry.meta.createdAt ?? "");
  if (Number.isNaN(createdAt)) return false; // legacy/manual entries: keep, cleanup reconciles
  return now.getTime() - createdAt > SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
};

export async function readShare(store: ShareStore, id: string, now: Date): Promise<ShareStoreEntry | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const entry = await store.get(keyFor(id));
  if (!entry) return null;
  if (isExpired(entry, now)) {
    await store.delete(keyFor(id));
    const stats = await readStats(store);
    await writeStats(store, {
      count: Math.max(0, stats.count - 1),
      bytes: Math.max(0, stats.bytes - Buffer.byteLength(entry.body, "utf8")),
    });
    return null;
  }
  return entry;
}

export async function deleteShare(store: ShareStore, id: string, deleteKey: string): Promise<"deleted" | "missing" | "forbidden"> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return "missing";
  const entry = await store.get(keyFor(id));
  if (!entry) return "missing";
  const expected = Buffer.from(entry.meta.deleteKeySha256 ?? "", "hex");
  const presented = createHash("sha256").update(deleteKey).digest();
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return "forbidden";
  await store.delete(keyFor(id));
  const stats = await readStats(store);
  await writeStats(store, {
    count: Math.max(0, stats.count - 1),
    bytes: Math.max(0, stats.bytes - Buffer.byteLength(entry.body, "utf8")),
  });
  return "deleted";
}

/**
 * Deletes every expired share, then rebuilds the stats entry authoritatively from the
 * listing plus per-blob byte metadata (self-healing the incremental byte counter).
 * Returns the count of shares removed. Note: nothing schedules this - it runs only if a
 * later, separately-decided caller invokes it; expiry is otherwise lazy at read time.
 */
export async function sweepExpired(store: ShareStore, now: Date): Promise<number> {
  let removed = 0;
  for (const key of await store.list()) {
    if (!key.startsWith("posts/")) continue;
    const entry = await store.get(key);
    if (entry && isExpired(entry, now)) {
      await store.delete(key);
      removed += 1;
    }
  }
  let liveCount = 0;
  let liveBytes = 0;
  for (const key of await store.list()) {
    if (!key.startsWith("posts/")) continue;
    const entry = await store.get(key);
    if (!entry) continue;
    liveCount += 1;
    const metaBytes = Number.parseInt(entry.meta.bytes ?? "", 10);
    liveBytes += Number.isFinite(metaBytes) && metaBytes >= 0 ? metaBytes : Buffer.byteLength(entry.body, "utf8");
  }
  await writeStats(store, { count: liveCount, bytes: liveBytes });
  return removed;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatPrice = (priceCents: number | null): string =>
  priceCents === null ? "" : `$${(priceCents / 100).toFixed(2)}`;

export interface PageBases {
  /** Origin serving /s/... (photo + canonical URL). */
  relayBase: string;
  /** Origin of the app for the #relay= deep link. */
  appBase: string;
}

export function renderSharePage(bundleText: string, id: string, bases: PageBases): string {
  const share = parseSharedBundle(bundleText);
  const post = share.posts[0];
  // Crawlers (iMessage's preview fetcher) don't run JavaScript: they read the og:* tags
  // below and that is the message card. A tapped link in a browser jumps straight into
  // the app's read-only view of the post; the rendered body stays as the no-JS fallback
  // and for anyone who prefers reading right here.
  const appViewUrl = JSON.stringify(`${bases.appBase}/shared/${id}`);
  const title = escapeHtml(post.title);
  const handle = escapeHtml(share.authorHandle);
  const photoUrl = post.photo ? `${bases.relayBase}/s/${id}/photo` : null;
  const descriptionSnippet = post.description.length > 200 ? `${post.description.slice(0, 197)}...` : post.description;
  const ogDescription = escapeHtml(descriptionSnippet || `A shared post from @${share.authorHandle} on eic.`);
  const metaLine = [
    post.category ? escapeHtml(post.category) : "",
    formatPrice(post.priceCents),
    new Date(post.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
    `from @${handle}`,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} - eic</title>
<meta property="og:type" content="article" />
<meta property="og:title" content="${title} - from @${handle} on eic" />
<meta property="og:site_name" content="eic - everybody is cool" />
<meta property="og:description" content="${ogDescription}" />
<meta property="og:url" content="${escapeHtml(`${bases.relayBase}/s/${id}`)}" />
${photoUrl ? `<meta property="og:image" content="${escapeHtml(photoUrl)}" />\n<meta name="twitter:card" content="summary_large_image" />\n` : ""}<script>location.replace(${appViewUrl});</script>
</head>
<body style="margin:0;background:#008080;font-family:'Courier New',monospace;display:flex;justify-content:center;padding:24px;box-sizing:border-box;">
<main style="background:#c0c0c0;border:2px outset #ffffff;max-width:480px;width:100%;padding:0 0 16px;">
<div style="background:#000080;color:#ffffff;padding:4px 8px;font-size:13px;font-weight:bold;">eic - a shared post</div>
<div style="padding:12px;">
${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${title}" style="width:100%;border:2px inset #ffffff;box-sizing:border-box;" />\n` : ""}<h1 style="font-size:18px;margin:8px 0 4px;">${title}</h1>
<p style="font-size:12px;color:#404040;margin:0 0 8px;">${metaLine}</p>
<p style="font-size:13px;white-space:pre-wrap;margin:0 0 12px;">${escapeHtml(post.description) || "No description."}</p>
<p style="margin:0 0 8px;"><a href="${escapeHtml(`${bases.appBase}/shared/${id}`)}" style="display:inline-block;background:#c0c0c0;border:2px outset #ffffff;padding:6px 16px;font-size:14px;color:#000000;text-decoration:none;font-weight:bold;">Open in eic</a></p>
<p style="font-size:11px;color:#404040;margin:8px 0 0;">Anyone with this link can see this post. The sender can revoke the link at any time; unshared posts are never here. The author name is self-asserted: the post is signed, but a signer chooses their own handle.</p>
</div>
</main>
</body>
</html>`;
}

export function renderMissingPage(bases: PageBases): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Post not available - eic</title>
</head>
<body style="margin:0;background:#008080;font-family:'Courier New',monospace;display:flex;justify-content:center;padding:24px;box-sizing:border-box;">
<main style="background:#c0c0c0;border:2px outset #ffffff;max-width:480px;width:100%;padding:0 0 16px;">
<div style="background:#000080;color:#ffffff;padding:4px 8px;font-size:13px;font-weight:bold;">eic - a shared post</div>
<div style="padding:12px;">
<h1 style="font-size:18px;margin:8px 0 4px;">That shared post is gone</h1>
<p style="font-size:13px;margin:0 0 12px;">The link was revoked, expired, or never existed. Ask your friend for a fresh one.</p>
<p style="margin:0;"><a href="${escapeHtml(`${bases.appBase}/`)}" style="color:#0000cc;font-size:13px;">Open eic</a></p>
</div>
</main>
</body>
</html>`;
}

/** First photo of the first post (media preferred over thumb) for og:image + page render. */
export function extractPhoto(bundleText: string): { mime: string; bytes: Buffer } | null {
  const share = parseSharedBundle(bundleText);
  const photo = share.posts[0].photo;
  return photo ? { mime: photo.mime, bytes: Buffer.from(photo.data, "base64") } : null;
}
