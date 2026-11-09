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
 *   a read that finds an EXPIRED entry deletes it on sight; active entries are unchanged; sweepExpired is available for a later, separately-decided cron
 * - revocation: the creator alone gets a delete key at publish; presenting it deletes
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_RELAY_BUNDLE_BYTES = 4 * 1024 * 1024;
export const SHARE_RETENTION_DAYS = 90;
// Global storage bounds remain approximate: post creation and shared accounting are
// not one transaction. ETag CAS below makes per-client rate claims conditional, but
// does not turn multi-object storage accounting into an atomic budget guarantee.
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
  /** Store ETag for conditional writes; undefined on stores without CAS (e.g. tests). */
  etag?: string;
}

export interface SharePutCondition {
  /** Create only if the key is absent (blobs v11 onlyIfNew). */
  onlyIfNew?: boolean;
  /** Update only if the current ETag matches (blobs v11 onlyIfMatch). */
  onlyIfMatch?: string;
}

export interface ShareStore {
  put(key: string, body: string, meta: Record<string, string>, condition?: SharePutCondition): Promise<{ modified: boolean }>;
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = await store.get(key);
    let windowStart = now.getTime();
    let count = 0;
    if (entry) {
      if (!entry.etag) throw new ShareError("Share rate accounting is unavailable.", 503);
      try {
        const parsed = JSON.parse(entry.body) as { start?: unknown; count?: unknown };
        if (typeof parsed.start !== "number" || !Number.isFinite(parsed.start) ||
            typeof parsed.count !== "number" || !Number.isInteger(parsed.count) || parsed.count < 0) {
          throw new Error("Invalid counter");
        }
        if (now.getTime() - parsed.start < PUBLISH_RATE_WINDOW_MS) {
          windowStart = parsed.start;
          count = parsed.count;
        }
      } catch { throw new ShareError("Share rate accounting is unavailable.", 503); }
    }
    if (count >= PUBLISH_RATE_LIMIT) throw new ShareError("Too many shares from this connection. Try again later.", 429);
    const result = await store.put(key, JSON.stringify({ start: windowStart, count: count + 1 }), {},
      entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new ShareError("Share rate accounting is busy. Try again later.", 503);
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
  /** Client-provisioned share id the signature binds (see createShare). */
  id: string | null;
}

/** Maximum age of a publish proof. */
export const PUBLISH_PROOF_WINDOW_MS = 5 * 60 * 1000;
/** Small future allowance for client clock skew only - NOT a second validity window. */
export const PUBLISH_PROOF_FUTURE_SKEW_MS = 60 * 1000;

/**
 * Fresh-owner-intent proof: every publish must carry a fresh Ed25519 signature from the
 * bundle author's key over "eic-share-publish:v1\n<sha256hex(bundle)>\n<timestamp>\n<share id>".
 * The bundle itself is long-lived signed content anyone can copy; this proof is what a
 * captured bundle can never mint, so replayed files can never be published or
 * resurrected, while the real author can always re-share (fresh id + delete key each
 * time - no lockout, no dedupe oracle). Residual hole, documented: a body + proof
 * captured together can be replayed inside the 5-minute window; treat shares as bearer
 * content during that window.
 */
export async function verifyPublishProof(body: string, proof: PublishProof, provision: ShareProvision, now: Date): Promise<void> {
  if (!proof.signature || !proof.at || !proof.id) {
    throw new ShareError("Sharing needs a fresh signature from the author's device.", 401);
  }
  if (proof.id !== provision.id) {
    throw new ShareError("That share signature does not match this link id.", 401);
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
  // The signed intent binds the delete key's hash too: swapping the key in a captured
  // request fails verification instead of becoming a TLS-only residual.
  const keyDigest = createHash("sha256").update(provision.deleteKey).digest("hex");
  const payload = new TextEncoder().encode(`eic-share-publish:v1
${digest}
${proof.at}
${proof.id}
${keyDigest}`);
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", b64ToBytes(pubkey), { name: "Ed25519" }, false, ["verify"]);
    const ok = await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(proof.signature) as BufferSource, payload);
    if (!ok) throw new ShareError("That share signature does not match this post.", 403);
  } catch (caught) {
    if (caught instanceof ShareError) throw caught;
    throw new ShareError("That share signature could not be verified.", 403);
  }
}

export interface ShareProvision {
  /** Client-generated id (16-64 base64url chars); persisted client-side before publishing. */
  id: string;
  /** Client-generated delete key (>=32 chars); only its sha256 is stored. */
  deleteKey: string;
}

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Publishes are client-provisioned and idempotent: the caller generates id + deleteKey
 * and keeps them in its vault BEFORE posting, so a lost response or a dead tab can
 * never orphan a live link - retrying the same id with a fresh proof is safe. The proof
 * binds the id, so only the bundle author can claim an id. An existing id with the same
 * bytes is the retry of an already-committed publish (200-style "existed"); the same id
 * with different bytes is rejected 409.
 */
export async function createShare(
  store: ShareStore,
  body: string,
  now: Date,
  proof: PublishProof,
  provision: ShareProvision,
  clientKey?: string,
): Promise<{ id: string; deleteKey: string; expiresAt: string; existed: boolean }> {
  if (!SHARE_ID_PATTERN.test(provision.id)) {
    throw new ShareError("That share link id is malformed.");
  }
  if (typeof provision.deleteKey !== "string" || provision.deleteKey.length < 32) {
    throw new ShareError("That share delete key is malformed.");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_RELAY_BUNDLE_BYTES) {
    throw new ShareError("That post is too large to share as a link.", 413);
  }
  // Charge bounded attempts before parsing and signature verification. Invalid attempts
  // consume quota too; storage/accounting failures remain fail-closed.
  if (clientKey) await checkPublishRate(store, clientKey, now);
  parseSharedBundle(body); // validate before storing; the stored bytes are the raw bundle
  // Nothing unsigned or tampered becomes a share page or a message card.
  if (!(await verifyShareSignature(body))) {
    throw new ShareError("That share is not signed by its author.");
  }
  await verifyPublishProof(body, proof, provision, now);
  // A live revoke marker for this id+key blocks the create before any write.
  await checkRevokeMarker(store, provision, now);
  // Count is derived live from the listing (self-healing); bytes stay incremental and
  // are reconciled by sweepExpired, because list() exposes no sizes in blobs v11. The
  // count/bytes caps remain SOFT: onlyIfNew makes each create atomic per key, but the
  // cap check itself is a read-then-write, so concurrent in-flight publishes of
  // distinct ids can all pass it. These caps stop bulk abuse in the expected case;
  // they are not a budget guarantee.
  const count = (await store.list()).filter((key) => key.startsWith("posts/")).length;
  const stats = await readStats(store);
  if (count >= MAX_SHARE_COUNT || stats.bytes + bodyBytes > MAX_SHARE_STORE_BYTES) {
    throw new ShareError("The share service is full right now. Try again later.", 503);
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const meta = {
    createdAt,
    deleteKeySha256: createHash("sha256").update(provision.deleteKey).digest("hex"),
    bytes: String(bodyBytes),
    expiresAt,
  };
  // Atomic create-if-absent (blobs v11 onlyIfNew): concurrent creates of the same id
  // cannot double-store; a delayed/retried create is resolved exactly once.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const put = await store.put(keyFor(provision.id), body, meta, { onlyIfNew: true });
    if (put.modified) {
      // Revoke ordering closure: deleteShare writes its marker BEFORE deleting the
      // post, so if a revoke's marker is visible now (strong read), our create lost
      // and we undo it. If the marker lands after this read, the revoke's own post
      // delete removes our entry: either way revoke wins, bounded by one request's
      // latency, up to the store's strong-consistency guarantee. The recheck blocks
      // markers live at the request's start OR at the recheck itself, so even a
      // create stalled past the marker TTL mid-request cannot resurrect the link.
      // (Platform sync-function execution limits are far below the TTL anyway.)
      if ((await readRevokeMarker(store, provision, now)) || (await readRevokeMarker(store, provision, new Date()))) {
        await store.delete(keyFor(provision.id)).catch(() => undefined);
        throw new ShareError("That link was revoked.", 410);
      }
      await writeStats(store, { count: count + 1, bytes: stats.bytes + bodyBytes });
      return { id: provision.id, deleteKey: provision.deleteKey, expiresAt, existed: false };
    }
    const existing = await store.get(keyFor(provision.id));
    if (!existing) continue; // lost a create/delete race; retry the atomic create
    if (existing.body !== body) {
      throw new ShareError("That link id is already used for different content.", 409);
    }
    if (!isExpired(existing, now)) {
      // Idempotent retry of an already-committed publish: a TRUE no-op - the stored
      // entry (including createdAt/expiresAt) is left untouched and stats do not
      // double-count. Entries predating expiresAt meta expire by their createdAt.
      const existingExpiresAt =
        existing.meta.expiresAt ??
        (Number.isNaN(Date.parse(existing.meta.createdAt ?? ""))
          ? expiresAt
          : new Date(Date.parse(existing.meta.createdAt!) + SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString());
      return { id: provision.id, deleteKey: provision.deleteKey, expiresAt: existingExpiresAt, existed: true };
    }
    // Expired entry, same id: never silently renew retention. A re-share is an
    // explicit NEW intent with a NEW id (the client drops the stale pending intent
    // on this refusal), matching the established expiry semantics.
    throw new ShareError("That share link expired. Share again for a new link.", 410);
  }
  throw new ShareError("That share is being concurrently modified. Try again.", 409);
}

/**
 * Revoke markers are id-scoped sets of revoked key hashes, NOT content scoped, and
 * deliberately SHORT-lived: 15 minutes outlives the proof window plus every realistic
 * network/retry margin, and is far beyond the platform's maximum function execution
 * time (single-digit seconds to ~26s on Netlify), so an already-validated in-flight
 * create cannot outlive the marker that blocks it. Client discipline covers the rest:
 * a revoked intent's vault record is deleted, so no client path retries that id again
 * (a later re-share mints a fresh id). Markers cannot be used for arbitrary-id denial:
 * a create presenting a key whose hash is not in the set ignores the marker. Marker
 * writes MERGE into a verified/unverified split via CAS. Verified hashes come only
 * from key-checked deletes of a live entry (one per id incarnation; always recorded,
 * never dropped for junk). Unverified hashes come from absent-id deletes: junk-
 * tolerant, capped, droppable - they can never evict a verified hash. Forging a
 * legitimate hash needs a sha256 preimage. Two junk bounds hold: unverified merges
 * never extend the marker's window (deletedAt is refreshed only by verified writes),
 * so junk cannot keep a marker alive past its TTL; and a saturated unverified bucket
 * never silently drops a hash - the revoke fails loudly (409) so the client keeps its
 * pending delete key and the user's retry succeeds once the junk window expires.
 * Expired marker sets are reset on write, so stale junk carries no weight.
 * Residual, stated: after the marker TTL a delayed
 * create of the revoked id is not blocked server-side; that requires a client that
 * still retains the intent (its vault record was not synced with the revoke) AND a
 * fresh proof, which a third party cannot mint.
 */
const REVOKE_MARKER_TTL_MS = 15 * 60 * 1000;
const MARKER_MAX_VERIFIED = 16;
const MARKER_MAX_UNVERIFIED = 64;

const revokeMarkerKeyFor = (id: string) => `revoked/${id}`;

type MarkerSet = { verified: string[]; unverified: string[] };

const readMarkerSet = (marker: ShareStoreEntry | null): MarkerSet => {
  if (!marker) return { verified: [], unverified: [] };
  try {
    const parsed = JSON.parse(marker.body) as { verified?: unknown; unverified?: unknown };
    const pick = (value: unknown): string[] => (Array.isArray(value) ? value.filter((hash): hash is string => typeof hash === "string") : []);
    return { verified: pick(parsed.verified), unverified: pick(parsed.unverified) };
  } catch {
    return { verified: [], unverified: [] };
  }
};

const markerLive = (marker: ShareStoreEntry, now: Date): boolean => {
  const deletedAt = Date.parse(marker.meta.deletedAt ?? "");
  return !Number.isNaN(deletedAt) && now.getTime() - deletedAt <= REVOKE_MARKER_TTL_MS;
};

async function readRevokeMarker(store: ShareStore, provision: ShareProvision, now: Date): Promise<boolean> {
  const marker = await store.get(revokeMarkerKeyFor(provision.id));
  if (!marker || !markerLive(marker, now)) return false;
  const set = readMarkerSet(marker);
  const hash = createHash("sha256").update(provision.deleteKey).digest("hex");
  return set.verified.includes(hash) || set.unverified.includes(hash);
}

/** Adds a key hash to the id's marker set; CAS retry on contention. */
async function writeRevokeMarker(store: ShareStore, id: string, keyHashHex: string, now: Date, verified: boolean): Promise<void> {
  const key = revokeMarkerKeyFor(id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await store.get(key);
    // An expired marker carries no weight: start fresh rather than inherit stale junk.
    const set = existing && markerLive(existing, now) ? readMarkerSet(existing) : { verified: [], unverified: [] };
    if (verified) {
      if (!set.verified.includes(keyHashHex)) {
        set.verified = [...set.verified.slice(-(MARKER_MAX_VERIFIED - 1)), keyHashHex];
      }
    } else if (!set.verified.includes(keyHashHex) && !set.unverified.includes(keyHashHex)) {
      if (set.unverified.length >= MARKER_MAX_UNVERIFIED) {
        // Saturated with junk (a coordinated flood within one window): never silently
        // report a revoke that was not durably recorded. Fail loudly - the client keeps
        // the pending delete key, and junk expires within the TTL so a retry succeeds.
        throw new ShareError("That revoke is contended right now. Try again.", 409);
      }
      set.unverified = [...set.unverified, keyHashHex];
    }
    // Junk cannot hold a marker alive: unverified merges keep the original deletedAt;
    // only verified writes (or a fresh marker) extend the window.
    const deletedAt = existing && markerLive(existing, now) && !verified ? existing.meta.deletedAt : now.toISOString();
    const put = await store.put(key, JSON.stringify(set), { deletedAt }, existing?.etag ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
    if (put.modified) return;
  }
  throw new ShareError("That revoke is contended right now. Try again.", 409);
}

async function checkRevokeMarker(store: ShareStore, provision: ShareProvision, now: Date): Promise<void> {
  if (await readRevokeMarker(store, provision, now)) {
    throw new ShareError("That link was revoked.", 410);
  }
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

export async function deleteShare(store: ShareStore, id: string, deleteKey: string, now: Date = new Date(), clientKey?: string): Promise<"deleted" | "missing" | "forbidden"> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return "missing";
  const entry = await store.get(keyFor(id));
  if (!entry) {
    // Absent-id revoke: record the presented key's hash so a delayed/retried create
    // presenting the same key cannot resurrect the link. The merge keeps any existing
    // (legitimate) hashes, so this cannot clobber a real revoke. Rate-limited per
    // client like publishes, because junk hashes are the only abuse this path allows.
    if (clientKey) await checkPublishRate(store, `revoke:${clientKey}`, now);
    await writeRevokeMarker(store, id, createHash("sha256").update(deleteKey).digest("hex"), now, false);
    return "missing";
  }
  const expected = Buffer.from(entry.meta.deleteKeySha256 ?? "", "hex");
  const presented = createHash("sha256").update(deleteKey).digest();
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return "forbidden";
  // Marker before post delete: a concurrent create's post-put marker recheck observes
  // the revoke (strong read) and undoes itself; if the create's recheck ran first, this
  // post delete removes its entry. Either ordering ends revoked.
  await writeRevokeMarker(store, id, entry.meta.deleteKeySha256 ?? "", now, true);
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
