import { CATEGORIES, ItemSchema, type Bytes, type Category, type Item, type ItemType } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { MAX_MEDIA_PER_ITEM } from "@veil/media";

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const MOMENT_CATEGORY: Category = "moments";
export const LISTING_CATEGORIES = CATEGORIES.filter((category) => category !== MOMENT_CATEGORY);

export interface ComposeInput {
  type: ItemType;
  title: string;
  category: Category;
  /** Raw text from the price field, e.g. "340" or "12.50". Blank means free. */
  price: string;
  description: string;
}

export interface ComposedFields {
  type: ItemType;
  title: string;
  category: Category;
  priceCents: number | null;
  description: string;
}

export type ComposeErrors = Partial<Record<"title" | "price" | "description" | "media", string>>;

export type ComposeValidation =
  | { ok: true; fields: ComposedFields }
  | { ok: false; errors: ComposeErrors };

/** Blank and zero mean free (null). Returns NaN for anything that is not a plain dollar amount. */
export function parsePriceToCents(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents)) return Number.NaN;
  return cents === 0 ? null : cents;
}

export function validateCompose(input: ComposeInput, mediaCount: number): ComposeValidation {
  const errors: ComposeErrors = {};
  const title = input.title.trim();
  const description = input.description.trim();

  if (!title) errors.title = "Give it a title.";
  else if (title.length > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`;

  if (description.length > DESCRIPTION_MAX) {
    errors.description = `Keep the notes under ${DESCRIPTION_MAX} characters.`;
  }

  const priceCents = input.type === "listing" ? parsePriceToCents(input.price) : null;
  if (Number.isNaN(priceCents)) errors.price = "Enter a price like 25 or 12.50, or leave it blank for free.";

  if (input.type === "photo" && mediaCount === 0) errors.media = "A photo moment needs at least one photo.";
  if (mediaCount > MAX_MEDIA_PER_ITEM) errors.media = `Add at most ${MAX_MEDIA_PER_ITEM} photos.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    fields: {
      type: input.type,
      title,
      category: input.type === "photo" ? MOMENT_CATEGORY : input.category,
      priceCents,
      description,
    },
  };
}

/** One already-compressed image and its thumbnail, both in the same encoding. */
export interface ComposedMedia {
  bytes: Bytes;
  thumb: Bytes;
  mime: string;
}

/**
 * Encrypts each image and the first thumbnail into the vault, then the item that points at them.
 * The feed renders the thumbnail, so only the first image needs one.
 */
export async function saveComposedItem(
  vault: UnlockedVault,
  fields: ComposedFields,
  media: ComposedMedia[],
  deps: { newId: () => string; now: Date },
): Promise<Item> {
  const mediaIds: string[] = [];
  for (const entry of media) {
    mediaIds.push(await vault.putRecord("media", entry.bytes));
  }
  const first = media[0];
  const thumbId = first ? await vault.putRecord("thumb", first.thumb) : null;

  const item = ItemSchema.parse({
    id: deps.newId(),
    ...fields,
    createdAt: deps.now.toISOString(),
    likes: 0,
    mediaIds,
    thumbId,
    mediaMime: first?.mime ?? "image/webp",
    schemaVersion: 1,
  });
  await vault.putItem(item);
  return item;
}
