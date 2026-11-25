import { z } from "zod";
import { AppError } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { defaultProfile, getProfile, ProfileSchema, type Profile } from "./profile";
import { loadSettings } from "./social";

// Separate encrypted settings record. Feed code only reads profile:<authorId>, never this draft.
const id = (authorId: string) => `profile-studio:${authorId}`;
export const ProfileSelectionSchema = z.object({
  bio: z.boolean(), avatar: z.boolean(), decorations: z.boolean(), theme: z.boolean(),
  song: z.boolean(), book: z.boolean(),
});
export const ProfileDraftSchema = z.object({
  format: z.literal("eic-profile-draft"), version: z.literal(1),
  profile: ProfileSchema,
  revision: z.number().int().nonnegative().default(0),
  feedBaseline: ProfileSchema.nullable().default(null),
  song: z.string().trim().max(120), book: z.string().trim().max(120),
  selected: ProfileSelectionSchema,
});
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

export function newProfileDraft(profile: Profile, existingShared = false): ProfileDraft {
  return ProfileDraftSchema.parse({ format: "eic-profile-draft", version: 1, profile, feedBaseline: existingShared ? profile : null, song: "", book: "",
    selected: { bio: existingShared, avatar: existingShared, decorations: existingShared, theme: existingShared, song: false, book: false } });
}

export async function loadProfileDraft(vault: UnlockedVault): Promise<ProfileDraft> {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle in Connections before editing your profile.");
  const raw = await vault.getJson(id(settings.authorId));
  if (raw !== null) {
    const draft = ProfileDraftSchema.safeParse(raw);
    if (!draft.success || draft.data.profile.authorId !== settings.authorId) throw new AppError("Your profile draft could not be read. Your saved feed profile is unchanged.");
    return draft.data;
  }
  const existing = await getProfile(vault, settings.authorId);
  return newProfileDraft(existing ?? defaultProfile(settings.authorId, settings.handle, new Date()), !!existing);
}

export async function saveProfileDraft(vault: UnlockedVault, draft: ProfileDraft): Promise<ProfileDraft> {
  const parsed = ProfileDraftSchema.parse(draft);
  const settings = await loadSettings(vault);
  if (!settings.authorId || settings.authorId !== parsed.profile.authorId) throw new AppError("This is not your profile draft.");
  const key = id(settings.authorId);
  const raw = await vault.getJson(key);
  const current = raw === null ? null : ProfileDraftSchema.safeParse(raw);
  if (current && (!current.success || current.data.revision !== parsed.revision)) {
    throw new AppError("Your private draft changed in another editor. Reopen your profile to review the latest saved draft. Nothing was overwritten.");
  }
  if (raw === null && parsed.revision !== 0) {
    throw new AppError("Your private draft changed. Reopen your profile before saving. Nothing was overwritten.");
  }
  const next = ProfileDraftSchema.parse({ ...parsed, revision: parsed.revision + 1 });
  try {
    await vault.putJsonIfUnchanged("settings", key, next, raw);
  } catch {
    throw new AppError("Your private draft could not be saved, or changed in another editor. Your edits are still here. Reopen your profile to review the latest saved draft before trying again.");
  }
  return next;
}

/** Exact legacy-v1 payload, with private fields omitted, not CSS-hidden. Never truncates. */
export function selectedProfile(draft: ProfileDraft, fallbackName: string): Profile {
  const { profile, selected, song, book } = ProfileDraftSchema.parse(draft);
  const bio = [selected.bio ? profile.bio : "", selected.song && song ? `Favorite song: ${song}` : "", selected.book && book ? `Favorite book: ${book}` : ""].filter(Boolean).join("\n\n");
  if (bio.length > 500) throw new AppError(`Selected bio and favorites use ${bio.length}/500 characters. Shorten them or uncheck a field. Nothing was updated.`);
  const baseline = defaultProfile(profile.authorId, fallbackName, new Date(profile.updatedAt));
  return ProfileSchema.parse({ ...profile, bio, avatar: selected.avatar ? profile.avatar : null,
    decorations: selected.decorations ? profile.decorations : [], theme: selected.theme ? profile.theme : baseline.theme });
}

export async function updateFeedProfile(vault: UnlockedVault, draft: ProfileDraft, now: Date): Promise<Profile> {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle || draft.profile.authorId !== settings.authorId) throw new AppError("Choose your own handle first.");
  const raw = await vault.getJson(`profile:${settings.authorId}`);
  const current = raw === null ? null : ProfileSchema.parse(raw);
  if (JSON.stringify(current) !== JSON.stringify(draft.feedBaseline)) {
    throw new AppError("The saved profile changed. Review the latest feed profile before updating. Your private draft is safe; nothing was overwritten.");
  }
  const profile = ProfileSchema.parse({ ...selectedProfile(draft, settings.handle), seq: (current?.seq ?? 0) + 1, updatedAt: now.toISOString() });
  await vault.putJsonIfUnchanged("profile", `profile:${settings.authorId}`, profile, raw);
  return profile;
}

/** Explicit review action advances only the baseline, never shares or replaces private fields. */
export async function reviewLatestFeedProfile(vault: UnlockedVault, draft: ProfileDraft): Promise<ProfileDraft> {
  const settings = await loadSettings(vault);
  if (!settings.authorId || settings.authorId !== draft.profile.authorId) throw new AppError("This is not your profile draft.");
  return ProfileDraftSchema.parse({ ...draft, feedBaseline: await getProfile(vault, settings.authorId) });
}
