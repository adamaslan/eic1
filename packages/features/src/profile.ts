import { z } from "zod";
import { AppError, VaultCorruptError, decodeBase64, encodeBase64, type Settings } from "@veil/core";
import { signPayload, verifySignature } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { loadOrCreateShareIdentity } from "./sharing";
import { loadSettings } from "./social";

// eic-profile v1 (design draft, homebase PR #40 section 1): the profile is a vault record kind
// (`profile`) and rides the feed as a signed chunk. One record per author, replaced whole -
// sync is LWW by (authorId, seq), so decoration removals need no separate tombstone. All theme
// values come from the fixed built-in palette (zero wire cost); only avatar/decoration assets
// carry bytes, inside the pinned caps.

export const PROFILE_FORMAT = "eic-profile";
export const PROFILE_VERSION = 1;
export const PROFILE_RECORD_PREFIX = "profile:";
export const PROFILE_AVATAR_MAX_BYTES = 25 * 1024;
export const PROFILE_DECORATION_MAX_BYTES = 25 * 1024;
export const PROFILE_MAX_DECORATIONS = 32;
export const PROFILE_TOTAL_ASSET_MAX_BYTES = 256 * 1024;
export const PROFILE_BIO_MAX = 500;
export const PROFILE_DISPLAY_NAME_MAX = 40;

// Built-in palette (design draft section 4a: the enum value IS the theme - no asset bytes).
export const WALLPAPERS = ["teal", "clouds", "dither", "none"] as const;
export const COLOR_SCHEMES = ["win95", "vapor", "midnight", "hot-dog-stand"] as const;
export const WINDOW_ACCENTS = ["blue", "silver", "magenta", "lime"] as const;
export const FONT_CHOICES = ["ms-sans", "fixed", "pixel"] as const;

const DataUriAssetSchema = z.object({
  kind: z.literal("data-uri"),
  // Raster/vector image bytes only; anything else (text/html et al.) is rejected on save and on import.
  mime: z.string().regex(/^image\//).max(100),
  data: z.string().min(1), // base64; byte cap enforced below
});

const ThemeSchema = z.object({
  wallpaper: z.enum(WALLPAPERS),
  colorScheme: z.enum(COLOR_SCHEMES),
  windowAccent: z.enum(WINDOW_ACCENTS),
  fontChoice: z.enum(FONT_CHOICES),
});

const DecorationSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.string().min(1).max(40),
  asset: z.union([DataUriAssetSchema, z.object({ kind: z.literal("inline-svg"), data: z.string().min(1) })]),
  position: z.object({ x: z.number(), y: z.number(), z: z.number().int() }),
  scale: z.number().positive().max(10),
  rotation: z.number().min(-360).max(360),
});

export type Decoration = z.infer<typeof DecorationSchema>;

export const ProfileSchema = z
  .object({
    format: z.literal(PROFILE_FORMAT),
    version: z.literal(PROFILE_VERSION),
    authorId: z.string().min(1),
    displayName: z.string().trim().min(1).max(PROFILE_DISPLAY_NAME_MAX),
    bio: z.string().max(PROFILE_BIO_MAX).default(""),
    avatar: DataUriAssetSchema.nullable().default(null),
    theme: ThemeSchema.default({ wallpaper: "teal", colorScheme: "win95", windowAccent: "blue", fontChoice: "ms-sans" }),
    decorations: z.array(DecorationSchema).max(PROFILE_MAX_DECORATIONS).default([]),
    updatedAt: z.iso.datetime(),
    seq: z.number().int().positive(),
  })
  .superRefine((profile, ctx) => {
    const assetBytes = (asset: { mime?: string; data: string } | null): number =>
      asset ? Math.floor((asset.data.length * 3) / 4) : 0;
    if (assetBytes(profile.avatar) > PROFILE_AVATAR_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "Avatar is over the 25 KB cap.", path: ["avatar"] });
    }
    let total = assetBytes(profile.avatar);
    for (const decoration of profile.decorations) {
      const bytes = decoration.asset.kind === "inline-svg" ? new TextEncoder().encode(decoration.asset.data).byteLength : assetBytes(decoration.asset);
      if (bytes > PROFILE_DECORATION_MAX_BYTES) {
        ctx.addIssue({ code: "custom", message: `Decoration "${decoration.id}" is over the 25 KB cap.`, path: ["decorations"] });
      }
      total += bytes;
    }
    if (total > PROFILE_TOTAL_ASSET_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "Profile assets are over the 256 KB total cap.", path: ["decorations"] });
    }
  });
export type Profile = z.infer<typeof ProfileSchema>;

// The signed wrapper that rides the feed as the profile chunk. The signature covers the
// profile JSON; the manifest additionally pins the chunk hash.
export const SignedProfileSchema = z.object({
  format: z.literal("eic-profile-signed"),
  version: z.literal(1),
  profile: ProfileSchema,
  pubkey: z.string().min(1),
  signature: z.string().min(1),
});
export type SignedProfile = z.infer<typeof SignedProfileSchema>;

const profileRecordId = (authorId: string): string => `${PROFILE_RECORD_PREFIX}${authorId}`;

export function defaultProfile(authorId: string, displayName: string, now: Date): Profile {
  return ProfileSchema.parse({ format: PROFILE_FORMAT, version: PROFILE_VERSION, authorId, displayName, updatedAt: now.toISOString(), seq: 1 });
}

/** Loads any stored profile by author id; unreadable or foreign records are absent, not errors. */
export async function getProfile(vault: UnlockedVault, authorId: string): Promise<Profile | null> {
  const raw = await vault.getJson(profileRecordId(authorId));
  if (raw === null) return null;
  const parsed = ProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Saves or creates MY profile, bumping seq on every edit. Rejects cap violations. */
export async function saveOwnProfile(
  vault: UnlockedVault,
  edit: Omit<Profile, "format" | "version" | "authorId" | "updatedAt" | "seq">,
  now: Date,
): Promise<Profile> {
  const settings: Settings = await loadSettings(vault);
  if (!settings.authorId) throw new AppError("Choose a handle before editing your profile.");
  const existing = await getProfile(vault, settings.authorId);
  const profile = ProfileSchema.parse({
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    authorId: settings.authorId,
    ...edit,
    updatedAt: now.toISOString(),
    seq: (existing?.seq ?? 0) + 1,
  });
  await vault.putJson("profile", profileRecordId(profile.authorId), profile);
  return profile;
}

/** Signs a profile for the feed chunk. */
export async function signProfile(vault: UnlockedVault, profile: Profile): Promise<SignedProfile> {
  const identity = await loadOrCreateShareIdentity(vault);
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(JSON.stringify(profile)));
  return { format: "eic-profile-signed", version: 1, profile, pubkey: encodeBase64(identity.publicKey), signature: encodeBase64(signature) };
}

/** Verifies a signed profile against the connection's pinned key. Fails closed. */
export async function verifySignedProfile(signed: SignedProfile, expectedAuthorId: string, pubkeyBase64: string): Promise<void> {
  if (signed.profile.authorId !== expectedAuthorId) throw new VaultCorruptError("That profile belongs to someone else.");
  if (signed.pubkey !== pubkeyBase64) throw new VaultCorruptError("That profile was signed with a different key than this connection's.");
  const ok = await verifySignature(
    decodeBase64(pubkeyBase64),
    new TextEncoder().encode(JSON.stringify(signed.profile)),
    decodeBase64(signed.signature),
  );
  if (!ok) throw new VaultCorruptError("That profile's signature does not check out.");
}

export function parseSignedProfile(text: string): SignedProfile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That profile chunk is damaged.");
  }
  const parsed = SignedProfileSchema.safeParse(json);
  if (!parsed.success) throw new VaultCorruptError("That profile chunk is damaged.");
  return parsed.data;
}

/**
 * Applies a verified connection profile: whole-record LWW by (authorId, seq). Equal or older
 * seq is a no-op (idempotent re-pull); a newer seq replaces everything, so decoration removals
 * propagate without tombstones. Own profiles are never overwritten by a pull.
 */
export async function applyProfile(vault: UnlockedVault, profile: Profile): Promise<{ applied: boolean }> {
  const settings = await loadSettings(vault);
  if (settings.authorId && profile.authorId === settings.authorId) return { applied: false };
  const existing = await getProfile(vault, profile.authorId);
  if (existing && profile.seq <= existing.seq) return { applied: false };
  await vault.putJson("profile", profileRecordId(profile.authorId), ProfileSchema.parse(profile));
  return { applied: true };
}
