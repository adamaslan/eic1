import { z } from "zod";
import {
  AppError,
  ConnectionSchema,
  ItemSchema,
  VaultCorruptError,
  decodeBase64,
  encodeBase64,
  type Bytes,
  type EncryptedRecord,
  type Item,
  type Settings,
} from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { isValidFeedUrl } from "./feed";
import { MAX_MEDIA_PER_ITEM } from "@veil/media";
import { generateSigningKeyPair, signPayload, verifySignature } from "@veil/crypto";
import { addNote } from "./social";

export const SHARE_FORMAT = "eic-share";
const SHARE_VERSION = 1;
const SHARE_VERSION_V2 = 2;
export const MAX_SHARE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_POSTS = 100;
const MAX_LIKES = 5000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/webp", "image/jpeg", "image/png"] as const;
// Components of namespaced record ids must not contain the separator.
const idField = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const MediaSchema = z.object({ mime: z.enum(ALLOWED_MIME), data: z.string() });

const PostSchema = z.object({
  id: idField,
  type: z.enum(["photo", "listing"]),
  title: z.string().min(1).max(120),
  category: ItemSchema.shape.category,
  priceCents: z.number().int().nonnegative().nullable(),
  description: z.string().max(2000),
  createdAt: z.iso.datetime(),
  likes: z.number().int().nonnegative(),
  likedBy: z.array(idField).default([]),
  media: z.array(MediaSchema).max(MAX_MEDIA_PER_ITEM),
  thumb: MediaSchema.nullable(),
});

const ShareBundleSchema = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION),
  exportedAt: z.iso.datetime(),
  author: z.object({ id: idField, handle: ConnectionSchema.shape.handle }),
  posts: z.array(PostSchema).max(MAX_POSTS).refine(
    (posts) => new Set(posts.map((post) => post.id)).size === posts.length,
    "Duplicate post ids are not allowed.",
  ),
  // Posts by other people that the author liked: { ownerId, postId } as that owner knows them.
  likes: z.array(z.object({ ownerId: idField, postId: idField })).max(MAX_LIKES),
  // False when the bundle is one post shared on its own: then `likes` is not the author's full
  // like snapshot, and the importer must not reconcile (it would strip the author's other likes).
  likesComplete: z.boolean().optional(),
});
export type ShareBundle = z.infer<typeof ShareBundleSchema>;

const ShareBundleV2Schema = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION_V2),
  exportedAt: z.iso.datetime(),
  author: z.object({
    id: idField,
    handle: ConnectionSchema.shape.handle,
    // Ed25519 public key, base64. Signs `signature` over the bundle without that field.
    pubkey: z.string().min(1),
    // Where this author publishes their encrypted feed (eic-feed v1). Absent until sync lands.
    feedUrl: z.string().min(1).optional(),
  }),
  posts: z.array(PostSchema).max(MAX_POSTS).refine(
    (posts) => new Set(posts.map((post) => post.id)).size === posts.length,
    "Duplicate post ids are not allowed.",
  ),
  likes: z.array(z.object({ ownerId: idField, postId: idField })).max(MAX_LIKES),
  likesComplete: z.boolean().optional(),
  signature: z.string().min(1),
});
export type ShareBundleV2 = z.infer<typeof ShareBundleV2Schema>;

// Canonical signed payload: the schema-parsed bundle minus its signature. JSON.stringify is
// deterministic for schema-round-tripped values, so signer and verifier serialize identically.
function signingPayload(bundle: ShareBundleV2): Bytes {
  const { signature: _signature, ...unsigned } = bundle;
  return new TextEncoder().encode(JSON.stringify(unsigned));
}

// Per-author Ed25519 identity, sealed in the vault like any other secret. Created on first share.
const SHARE_IDENTITY_RECORD_ID = "identity:share";
const ShareIdentitySchema = z.object({
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  schemaVersion: z.literal(1),
});

export async function loadOrCreateShareIdentity(vault: UnlockedVault): Promise<{ publicKey: Bytes; secretKey: Bytes }> {
  const existing = ShareIdentitySchema.safeParse(await vault.getJson(SHARE_IDENTITY_RECORD_ID));
  if (existing.success) {
    return { publicKey: decodeBase64(existing.data.publicKey), secretKey: decodeBase64(existing.data.secretKey) };
  }
  const pair = await generateSigningKeyPair();
  await vault.putJson("identity", SHARE_IDENTITY_RECORD_ID, {
    publicKey: encodeBase64(pair.publicKey),
    secretKey: encodeBase64(pair.secretKey),
    schemaVersion: 1,
  });
  return pair;
}

const importedId = (authorId: string, postId: string) => `post:${authorId}:${postId}`;

/**
 * Builds a share file from my shareable posts and the likes I have given. The file is plain
 * JSON on purpose: sharing a post means anyone holding the file can read it. Private posts,
 * notes, and settings never go in.
 */
export async function buildShareBundle(
  vault: UnlockedVault,
  settings: Settings,
  items: Item[],
  now: Date,
  options: { onlyPostId?: string } = {},
): Promise<{ text: string; postCount: number }> {
  if (!settings.authorId || !settings.handle) {
    throw new AppError("Choose a handle before sharing.");
  }
  const single = options.onlyPostId !== undefined;
  const likedPosts = items.filter((item) => {
    if (single || item.authorId === null || !item.likedByMe) return false;
    const prefix = `post:${item.authorId}:`;
    return item.id.startsWith(prefix) && item.id.length > prefix.length;
  });
  if (likedPosts.length > MAX_LIKES) {
    throw new AppError(`Too many liked posts to share. The limit is ${MAX_LIKES}.`);
  }
  // Pressing Share on one post is the consent, so a private post can go out that way. Imported posts never do.
  const mine = single
    ? items.filter((item) => item.authorId === null && item.id === options.onlyPostId)
    : items.filter((item) => item.authorId === null && item.visibility === "shareable");
  if (single && mine.length === 0) throw new AppError("Only your own posts can be shared.");
  const posts: ShareBundle["posts"] = [];
  for (const item of mine.slice(0, MAX_POSTS)) {
    const media: ShareBundle["posts"][number]["media"] = [];
    for (const mediaId of item.mediaIds) {
      const bytes = await vault.getRecord(mediaId);
      if (bytes) media.push({ mime: toMime(item.mediaMime), data: encodeBase64(bytes) });
    }
    const thumbBytes = item.thumbId ? await vault.getRecord(item.thumbId) : null;
    posts.push({
      id: item.id,
      type: item.type,
      title: item.title,
      category: item.category,
      priceCents: item.priceCents,
      description: item.description,
      createdAt: item.createdAt,
      likes: item.likes,
      likedBy: item.likedBy,
      media,
      thumb: thumbBytes ? { mime: toMime(item.mediaMime), data: encodeBase64(thumbBytes) } : null,
    });
  }
  const likes = likedPosts.map((item) => ({
    ownerId: item.authorId as string,
    postId: item.id.slice(`post:${item.authorId}:`.length),
  }));

  const identity = await loadOrCreateShareIdentity(vault);
  const unsigned = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION_V2,
    exportedAt: now.toISOString(),
    author: {
      id: settings.authorId,
      handle: settings.handle,
      pubkey: encodeBase64(identity.publicKey),
      ...(settings.feedUrl ? { feedUrl: settings.feedUrl } : {}),
    },
    posts,
    likes,
    likesComplete: !single,
  } as const;
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const text = JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
  if (new TextEncoder().encode(text).byteLength >= MAX_SHARE_FILE_BYTES) {
    throw new AppError("That share file is too large. Make fewer posts shareable and try again.");
  }
  return { text, postCount: posts.length };
}

export function parseShareBundle(text: string): ShareBundle | ShareBundleV2 {
  if (new TextEncoder().encode(text).byteLength >= MAX_SHARE_FILE_BYTES) {
    throw new VaultCorruptError("That file is too large.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That file is not a share file.");
  }
  if ((json as { version?: unknown }).version === SHARE_VERSION_V2) {
    const v2 = ShareBundleV2Schema.safeParse(json);
    if (!v2.success) {
      throw new VaultCorruptError("That file is not a share file, or it is from a newer version.");
    }
    return v2.data;
  }
  const parsed = ShareBundleSchema.safeParse(json);
  if (!parsed.success) {
    throw new VaultCorruptError("That file is not a share file, or it is from a newer version.");
  }
  return parsed.data;
}

export interface ImportResult {
  handle: string;
  added: number;
  updated: number;
  likesReceived: number;
  // True when the bundle was an eic-share v2 file whose Ed25519 signature verified against the
  // author's embedded public key. v1 files are unsigned: trust comes from whoever sent the file.
  verified: boolean;
}

/**
 * Adds a connection's shared posts to this vault. Imported posts are copies owned by this vault
 * (re-encrypted under its key), marked with the author, and never re-shared. Importing the same
 * file twice updates text and counts but does not duplicate photos. There is no signature on the
 * file, so a handle or like in it is only as trustworthy as whoever sent it.
 */
export async function importShareBundle(
  vault: UnlockedVault,
  text: string,
  deps: { settings: Settings; newId: () => string; now: Date },
): Promise<ImportResult> {
  const bundle = parseShareBundle(text);
  let verified = false;
  if (bundle.version === SHARE_VERSION_V2) {
    let ok = false;
    try {
      ok = await verifySignature(
        decodeBase64(bundle.author.pubkey),
        signingPayload(bundle),
        decodeBase64(bundle.signature),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new VaultCorruptError("That share file's signature does not check out. Ask the sender for a fresh export.");
    }
    verified = true;
  }
  const { author } = bundle;
  if (!deps.settings.authorId) throw new AppError("Choose a handle before importing.");
  if (author.id === deps.settings.authorId) throw new AppError("That is your own share file.");

  const records: EncryptedRecord[] = [];
  let added = 0;
  let updated = 0;
  for (const post of bundle.posts) {
    const id = importedId(author.id, post.id);
    const existing = await vault.getItem(id);
    let mediaIds = existing?.mediaIds ?? [];
    let thumbId = existing?.thumbId ?? null;
    let mediaMime = existing?.mediaMime ?? "image/webp";
    if (!existing) {
      mediaIds = [];
      for (const media of post.media) {
        const record = await vault.sealRecord("media", decodeMedia(media.data));
        records.push(record);
        mediaIds.push(record.id);
      }
      if (post.thumb) {
        const record = await vault.sealRecord("thumb", decodeMedia(post.thumb.data));
        records.push(record);
        thumbId = record.id;
      }
      mediaMime = post.thumb?.mime ?? post.media[0]?.mime ?? "image/webp";
    }
    const likedByMe = existing?.likedByMe ?? false;
    const acknowledged = post.likedBy.includes(deps.settings.authorId);
    const item = ItemSchema.parse({
      id,
      type: post.type,
      title: post.title,
      category: post.category,
      priceCents: post.priceCents,
      description: post.description,
      createdAt: post.createdAt,
      // Reconcile my pending like or unlike against the owner's membership list.
      likes: Math.max(0, post.likes + (likedByMe && !acknowledged ? 1 : 0) - (!likedByMe && acknowledged ? 1 : 0)),
      mediaIds,
      thumbId,
      mediaMime,
      visibility: "private",
      authorId: author.id,
      authorHandle: author.handle,
      likedByMe,
      likedBy: [],
      schemaVersion: 1,
    });
    records.push(await vault.sealItem(item));
    if (existing) updated += 1;
    else added += 1;
  }

  // A single-post share carries no like snapshot; reconciling against it would erase this
  // author's existing likes on my posts. Only full bundles (or pre-flag files) reconcile.
  const reconcileLikes = bundle.likesComplete !== false;
  const myPosts = reconcileLikes ? (await vault.listItems()).filter((item) => item.authorId === null) : [];
  const liked = new Set(bundle.likes.filter((like) => like.ownerId === deps.settings.authorId).map((like) => like.postId));
  let likesReceived = 0;
  const noteTexts: string[] = [];
  for (const post of myPosts) {
    const wasLiked = post.likedBy.includes(author.id);
    const isLiked = liked.has(post.id);
    if (wasLiked !== isLiked) {
      const likedBy = post.likedBy.filter((id) => id !== author.id);
      if (isLiked) likedBy.push(author.id);
      const likes = Math.max(0, post.likes + (isLiked ? 1 : -1));
      records.push(await vault.sealItem({ ...post, likedBy, likes }));
    }
    if (isLiked && !wasLiked) {
      likesReceived += 1;
      noteTexts.push(`@${author.handle} liked "${post.title}".`);
    }
  }

  if (records.length > 0) await vault.putRecords(records);
  const connectionId = `connection:${author.id}`;
  const prior = ConnectionSchema.safeParse(await vault.getJson(connectionId));
  await vault.putJson("connection", connectionId, {
    id: author.id,
    handle: author.handle,
    // First import sets addedAt; re-imports refresh lastImportAt and keep nickname/hidden.
    addedAt: prior.success ? prior.data.addedAt : deps.now.toISOString(),
    nickname: prior.success ? prior.data.nickname : null,
    hidden: prior.success ? prior.data.hidden : false,
    lastImportAt: deps.now.toISOString(),
    pubkey: bundle.version === SHARE_VERSION_V2 ? bundle.author.pubkey : (prior.success ? prior.data.pubkey : null),
    // A bundle without a feedUrl keeps the prior one (re-exports may predate the publish setup);
    // an invalid feedUrl is dropped rather than stored.
    feedUrl:
      bundle.version === SHARE_VERSION_V2
        ? ((bundle.author.feedUrl && isValidFeedUrl(bundle.author.feedUrl) ? bundle.author.feedUrl : null) ??
          (prior.success ? prior.data.feedUrl : null))
        : prior.success
          ? prior.data.feedUrl
          : null,
    // Explicit re-import reset: bringing a bundle in by hand clears the sync cursors, so a
    // friend who rebuilt their vault (republishing at a lower seq) syncs again from their new
    // sequence. This is the user-initiated recovery path - pulls never roll back on their own.
    // Note this also runs when a posts chunk applies during sync; the pull then writes the
    // manifest cursors right after, so the reset only sticks for genuine re-imports.
    syncSeq: 0,
    syncEtag: null,
    syncPending: false,
    syncStatus: "",
    syncDetail: "",
    schemaVersion: 1,
  });
  if (added + updated > 0) {
    await addNote(vault, `Imported ${added} new and ${updated} updated posts from @${author.handle}.`, deps);
  }
  for (const noteText of noteTexts) await addNote(vault, noteText, deps);
  return { handle: author.handle, added, updated, likesReceived, verified };
}

function toMime(mime: string): (typeof ALLOWED_MIME)[number] {
  return (ALLOWED_MIME as readonly string[]).includes(mime) ? (mime as (typeof ALLOWED_MIME)[number]) : "image/webp";
}

function decodeMedia(data: string): Bytes {
  let bytes: Bytes;
  try {
    bytes = decodeBase64(data);
  } catch {
    throw new VaultCorruptError("A photo in that share file is damaged.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new VaultCorruptError("A photo in that share file is the wrong size.");
  }
  return bytes;
}
