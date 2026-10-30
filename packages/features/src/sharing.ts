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
import { MAX_MEDIA_PER_ITEM } from "@veil/media";
import { addNote } from "./social";

export const SHARE_FORMAT = "eic-share";
const SHARE_VERSION = 1;
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
  likedBy: z.array(idField),
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
});
export type ShareBundle = z.infer<typeof ShareBundleSchema>;

const importedId = (authorId: string, postId: string) => `post:${authorId}:${postId}`;

/**
 * Builds a share file from my shareable posts and the likes I have given. The file is plain
 * JSON on purpose: sharing a post means anyone holding the file can read it. Private posts,
 * notes, and settings never go in.
 */
export async function buildShareBundle(vault: UnlockedVault, settings: Settings, items: Item[], now: Date): Promise<{ text: string; postCount: number }> {
  if (!settings.authorId || !settings.handle) {
    throw new AppError("Choose a handle before sharing.");
  }
  const likedPosts = items.filter((item) => item.authorId !== null && item.likedByMe);
  if (likedPosts.length > MAX_LIKES) {
    throw new AppError(`Too many liked posts to share. The limit is ${MAX_LIKES}.`);
  }
  const mine = items.filter((item) => item.authorId === null && item.visibility === "shareable");
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

  const bundle: ShareBundle = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: now.toISOString(),
    author: { id: settings.authorId, handle: settings.handle },
    posts,
    likes,
  };
  const text = JSON.stringify(bundle);
  if (new TextEncoder().encode(text).byteLength >= MAX_SHARE_FILE_BYTES) {
    throw new AppError("That share file is too large. Make fewer posts shareable and try again.");
  }
  return { text, postCount: posts.length };
}

export function parseShareBundle(text: string): ShareBundle {
  if (new TextEncoder().encode(text).byteLength >= MAX_SHARE_FILE_BYTES) {
    throw new VaultCorruptError("That share file is too large.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That file is not a share file.");
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
    const item = ItemSchema.parse({
      id,
      type: post.type,
      title: post.title,
      category: post.category,
      priceCents: post.priceCents,
      description: post.description,
      createdAt: post.createdAt,
      // Add my pending like only until the owner acknowledges it in their membership list.
      likes: post.likes + (!post.likedBy.includes(deps.settings.authorId) && existing?.likedByMe ? 1 : 0),
      mediaIds,
      thumbId,
      mediaMime,
      visibility: "private",
      authorId: author.id,
      authorHandle: author.handle,
      likedByMe: existing?.likedByMe ?? false,
      likedBy: [],
      schemaVersion: 1,
    });
    records.push(await vault.sealItem(item));
    if (existing) updated += 1;
    else added += 1;
  }

  const myPosts = (await vault.listItems()).filter((item) => item.authorId === null);
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
  await vault.putJson("connection", `connection:${author.id}`, {
    id: author.id,
    handle: author.handle,
    addedAt: deps.now.toISOString(),
    schemaVersion: 1,
  });
  if (added + updated > 0) {
    await addNote(vault, `Imported ${added} new and ${updated} updated posts from @${author.handle}.`, deps);
  }
  for (const noteText of noteTexts) await addNote(vault, noteText, deps);
  return { handle: author.handle, added, updated, likesReceived };
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
