import { PROFILE_AVATARS } from "@veil/features";
import { wallpapers } from "@veil/tokens";
import type { Audience, Choices } from "./cookie-jar-store";
import { readPref, writePref, type PrefStores, type WriteResult } from "./local-pref";

// Room postcard (proposal P2): one wallpaper, one avatar sticker and a short message, handed to a
// friend as a file or copied text. There is deliberately NO upload: it goes through whatever the
// person already uses to message that friend. The sender previews the exact payload (I-6); the
// receiver sees it and accepts or declines before it is stored.

export const POSTCARD_FORMAT = "eic-room-postcard";
export const MAX_MESSAGE = 140;
export const MAX_POSTCARD_BYTES = 2048;
export const MAX_KEPT = 20;
export const RECEIVED_KEY = "eic.postcards.v1";
export const RECEIVED_PURPOSE = "received-postcards";

const WALLPAPER_IDS = new Set<string>(wallpapers.map((w) => w.id));
const AVATAR_IDS = new Set<string>(PROFILE_AVATARS.map((a) => a.id));

export interface PostcardSelection {
  wallpaper: string;
  avatarId: string;
  message: string;
}

export interface Postcard {
  format: typeof POSTCARD_FORMAT;
  v: 1;
  wallpaper: string;
  avatarId: string;
  message: string;
}

/** Everything a postcard can never carry. Shown to the sender; enforced by strict parsing. */
export const EXCLUDED = ["your name or handle", "journal entries", "profile fields", "connections", "photo location", "listening history", "device or timing data"] as const;

/** Strips control and bidi-override characters so a message cannot reorder or hide text. */
export function cleanMessage(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
}

export function sendAllowed(audience: Audience): { ok: boolean; reason: string } {
  if (audience === "just-me") return { ok: false, reason: "Your audience is Just me. Pick Friends' clubhouse or Showtime to send a postcard." };
  return { ok: true, reason: audience === "friends" ? "Send it only to the friends you choose." : "Anyone who gets this file can read it. Send it on purpose, one at a time." };
}

export interface PostcardPreview {
  card: Postcard;
  /** Byte-for-byte what leaves the device (I-6). The preview shows this string. */
  payload: string;
  bytes: number;
  excluded: readonly string[];
}

export function buildPostcard(selection: PostcardSelection): PostcardPreview | { error: string } {
  if (!WALLPAPER_IDS.has(selection.wallpaper)) return { error: "Pick a wallpaper from the list." };
  if (!AVATAR_IDS.has(selection.avatarId)) return { error: "Pick a sticker from the list." };
  const message = cleanMessage(selection.message);
  if (message.length === 0) return { error: "Write a short message first." };
  const card: Postcard = { format: POSTCARD_FORMAT, v: 1, wallpaper: selection.wallpaper, avatarId: selection.avatarId, message };
  const payload = JSON.stringify(card);
  return { card, payload, bytes: new TextEncoder().encode(payload).length, excluded: EXCLUDED };
}

const KEYS = ["format", "v", "wallpaper", "avatarId", "message"];

/** Strict: unknown fields are rejected, so nothing extra can ride along in a file. */
export function parsePostcard(text: string): Postcard | { error: string } {
  if (new TextEncoder().encode(text).length > MAX_POSTCARD_BYTES) return { error: "That postcard is too large." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "That is not a postcard." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "That is not a postcard." };
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !KEYS.includes(key))) return { error: "That postcard has extra data, so it was not opened." };
  if (value.format !== POSTCARD_FORMAT || value.v !== 1) return { error: "That is not a postcard." };
  if (typeof value.wallpaper !== "string" || !WALLPAPER_IDS.has(value.wallpaper)) return { error: "That postcard uses an unknown wallpaper." };
  if (typeof value.avatarId !== "string" || !AVATAR_IDS.has(value.avatarId)) return { error: "That postcard uses an unknown sticker." };
  if (typeof value.message !== "string") return { error: "That is not a postcard." };
  const message = cleanMessage(value.message);
  if (message.length === 0 || message !== value.message) return { error: "That postcard's message was not valid." };
  return { format: POSTCARD_FORMAT, v: 1, wallpaper: value.wallpaper, avatarId: value.avatarId, message };
}

function parseKept(raw: unknown): Postcard[] | null {
  if (!Array.isArray(raw)) return null;
  const cards: Postcard[] = [];
  for (const item of raw.slice(0, MAX_KEPT)) {
    const parsed = parsePostcard(JSON.stringify(item));
    if (!("error" in parsed)) cards.push(parsed);
  }
  return cards;
}

export function loadKept(choices: Choices, stores?: PrefStores): Postcard[] {
  return readPref(choices, RECEIVED_PURPOSE, RECEIVED_KEY, parseKept, stores) ?? [];
}

/** Receiver: Accept is the only way a postcard is stored. Declining stores nothing. */
export function acceptPostcard(choices: Choices, card: Postcard, stores?: PrefStores): { kept: Postcard[]; write: WriteResult } {
  const existing = loadKept(choices, stores);
  const kept = [card, ...existing.filter((c) => JSON.stringify(c) !== JSON.stringify(card))].slice(0, MAX_KEPT);
  return { kept, write: writePref(choices, RECEIVED_PURPOSE, RECEIVED_KEY, kept, stores) };
}

export function deleteKept(choices: Choices, index: number, stores?: PrefStores): Postcard[] {
  const kept = loadKept(choices, stores).filter((_, i) => i !== index);
  writePref(choices, RECEIVED_PURPOSE, RECEIVED_KEY, kept, stores);
  return kept;
}
