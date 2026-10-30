import { z } from "zod";

export const ITEM_TYPES = ["photo", "listing"] as const;
// "general" is internal: photo posts and old "moments"/"free" listings use it, and the UI never offers it.
export const CATEGORIES = ["general", "electronics", "bikes", "cameras", "tooling"] as const;
export const GENERAL_CATEGORY = "general";
const LEGACY_CATEGORIES: Record<string, (typeof CATEGORIES)[number]> = { moments: "general", free: "general" };

export const ItemTypeSchema = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemTypeSchema>;

// Vaults and share files written before "moments" and "free" were removed still hold those values.
export const CategorySchema = z.preprocess(
  (value) => (typeof value === "string" ? (LEGACY_CATEGORIES[value] ?? value) : value),
  z.enum(CATEGORIES),
);
export type Category = z.infer<typeof CategorySchema>;

export const ItemSchema = z.object({
  id: z.string().min(1),
  type: ItemTypeSchema,
  title: z.string().min(1).max(120),
  category: CategorySchema,
  // Integer cents. null means free (listings) or no price at all (photos).
  priceCents: z.number().int().nonnegative().nullable(),
  description: z.string().max(2000),
  createdAt: z.iso.datetime(),
  likes: z.number().int().nonnegative(),
  mediaIds: z.array(z.string()).default([]),
  thumbId: z.string().nullable().default(null),
  // Encoding of both the media and thumb records (the web picks WebP or JPEG per browser).
  mediaMime: z.string().default("image/webp"),
  // "shareable" posts may be put in a share file; "private" ones never leave the vault.
  visibility: z.enum(["private", "shareable"]).default("private"),
  // null means the post is mine. Otherwise it was imported from a connection's share file.
  authorId: z.string().nullable().default(null),
  authorHandle: z.string().nullable().default(null),
  likedByMe: z.boolean().default(false),
  // Connection ids that liked this post, learned from their share files. Only meaningful on my posts.
  likedBy: z.array(z.string()).default([]),
  schemaVersion: z.literal(1),
});
export type Item = z.infer<typeof ItemSchema>;
export type Visibility = Item["visibility"];
