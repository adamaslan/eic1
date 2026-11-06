import type { UnlockedVault } from "@veil/vault";
import { getProfile, type Profile } from "./profile";
import { loadProfileDraft } from "./profile-studio";
import { loadSettings } from "./social";

/** Local display only. A missing peer avatar must never fall back to the owner's private draft. */
export async function loadDisplayAvatar(vault: UnlockedVault, authorId?: string): Promise<Profile["avatar"]> {
  const settings = await loadSettings(vault);
  const id = authorId ?? settings.authorId;
  if (!id) return null;
  return id === settings.authorId
    ? (await loadProfileDraft(vault)).profile.avatar
    : (await getProfile(vault, id))?.avatar ?? null;
}
