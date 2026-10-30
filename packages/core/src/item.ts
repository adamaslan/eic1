import { z } from "zod";

export const ITEM_TYPES = ["photo", "listing"] as const;
export const CATEGORIES = ["moments", "electronics", "bikes", "cameras", "free"] as const;

export const ItemTypeSchema = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const CategorySchema = z.enum(CATEGORIES);
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
  schemaVersion: z.literal(1),
});
export type Item = z.infer<typeof ItemSchema>;
