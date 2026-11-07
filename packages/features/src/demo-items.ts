import type { Category, Item, ItemType } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { profileAvatarById, type ProfileAvatarId } from "./profile-avatars";

interface DemoItem {
  id: string;
  type: ItemType;
  title: string;
  category: Category;
  priceCents: number | null;
  description: string;
  ageMinutes: number;
  likes: number;
}

// Prototype items from the Win95 example, with stable ids so re-seeding overwrites instead of duplicating.
const DEMO_ITEMS: DemoItem[] = [
  { id: "demo-p1", type: "photo", title: "Fog on 5th Street bridge", category: "general", priceCents: null, description: "Shot at 6:12am. No filter, just cold air and a borrowed coat.", ageMinutes: 14, likes: 23 },
  { id: "demo-l1", type: "listing", title: "ThinkPad 701C — butterfly keyboard", category: "electronics", priceCents: 34000, description: "Works. Keys all present. Cash only, meet at the library steps.", ageMinutes: 120, likes: 41 },
  { id: "demo-p2", type: "photo", title: "Cat asleep on the radiator", category: "general", priceCents: null, description: "She has been here for four hours. Do not disturb.", ageMinutes: 38, likes: 118 },
  { id: "demo-l2", type: "listing", title: "Peugeot road bike, 1987", category: "bikes", priceCents: 12000, description: "Needs new tires. Frame is straight. No lowballs please.", ageMinutes: 300, likes: 12 },
  { id: "demo-p3", type: "photo", title: "Laundromat at midnight", category: "general", priceCents: null, description: "Fluorescent green everywhere. Nobody else around.", ageMinutes: 60, likes: 67 },
  { id: "demo-l3", type: "listing", title: "Free moving boxes (about 20)", category: "general", priceCents: null, description: "Porch pickup on Ash Street. Take all or some.", ageMinutes: 20, likes: 5 },
  { id: "demo-p4", type: "photo", title: "Rooftop, first warm day", category: "general", priceCents: null, description: "Everyone in the building came up at once.", ageMinutes: 180, likes: 94 },
  { id: "demo-l4", type: "listing", title: "Yashica T4 point & shoot", category: "cameras", priceCents: 41000, description: "Tested, light seals replaced. Comes with strap.", ageMinutes: 480, likes: 33 },
];

export interface SampleAuthor {
  handle: string;
  avatarId: ProfileAvatarId;
}

// Fictional authors for the signed-out landing examples, keyed by the stable demo ids, so visitors
// see how posts carry drawn avatars and handles. The sample items themselves stay authorless
// (authorId/authorHandle null): this is a display label for sample cards, never vault authorship.
// @maya matches the sample messages ("@maya liked ...", "Imported ... posts from @maya").
const SAMPLE_AUTHORS: Record<string, SampleAuthor> = {
  "demo-p1": { handle: "maya", avatarId: "seal" },
  "demo-p2": { handle: "juno", avatarId: "cat" },
  "demo-p3": { handle: "rex", avatarId: "alien" },
  "demo-p4": { handle: "maya", avatarId: "seal" },
  "demo-l1": { handle: "volt", avatarId: "robot" },
  "demo-l2": { handle: "otis", avatarId: "frog" },
  "demo-l3": { handle: "juno", avatarId: "dog" },
  "demo-l4": { handle: "maya", avatarId: "seal" },
};

export interface ResolvedSampleAuthor extends SampleAuthor {
  avatarLabel: string;
  avatarData: string;
}

/** Returns the fictional author shown with a sample item, with its drawn avatar, or null for real items. */
export function sampleAuthorFor(itemId: string): ResolvedSampleAuthor | null {
  const author = SAMPLE_AUTHORS[itemId];
  if (!author) return null;
  const avatar = profileAvatarById(author.avatarId);
  if (!avatar) return null;
  return { ...author, avatarLabel: avatar.label, avatarData: avatar.data };
}

/** Builds the prototype items without touching a vault. The landing preview shows these as labelled samples. */
export function getSampleItems(now: Date): Item[] {
  return DEMO_ITEMS.map((demo) => ({
    id: demo.id,
    type: demo.type,
    title: demo.title,
    category: demo.category,
    priceCents: demo.priceCents,
    description: demo.description,
    createdAt: new Date(now.getTime() - demo.ageMinutes * 60_000).toISOString(),
    likes: demo.likes,
    mediaIds: [],
    thumbId: null,
    mediaMime: "image/webp",
    visibility: "private",
    authorId: null,
    authorHandle: null,
    likedByMe: false,
    likedBy: [],
    schemaVersion: 1,
  }));
}

/** Dev-only: writes the prototype items as encrypted records. Safe to run twice. */
export async function seedDemoItems(vault: UnlockedVault, now: Date): Promise<number> {
  const items = getSampleItems(now);
  for (const item of items) {
    await vault.putItem(item);
  }
  return items.length;
}
