import { PROFILE_AVATARS } from "@veil/features";
import type { Choices } from "./cookie-jar-store";
import { readPref, removePref, writePref, type PrefStores, type WriteResult } from "./local-pref";

// Desk memory (proposal feature 1): a sticker tray and the last tool used. No names, handles
// or content - only ids from fixed lists - so reading it reveals nothing about the person.

export const DESK_KEY = "eic.desk.v1";
export const DESK_PURPOSE = "desk-memory";
export const TRAY_SIZE = 6;
export const TOOL_IDS = ["piano", "journal", "music", "calendar", "chores", "paint"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface Desk {
  tray: string[];
  lastTool: ToolId | null;
}

const AVATAR_IDS = new Set<string>(PROFILE_AVATARS.map((avatar) => avatar.id));

export function parseDesk(raw: unknown): Desk | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const tray = Array.isArray(value.tray)
    ? [...new Set(value.tray.filter((id): id is string => typeof id === "string" && AVATAR_IDS.has(id)))].slice(0, TRAY_SIZE)
    : [];
  const lastTool = TOOL_IDS.find((id) => id === value.lastTool) ?? null;
  return { tray, lastTool };
}

export const EMPTY_DESK: Desk = { tray: [], lastTool: null };

export function loadDesk(choices: Choices, stores?: PrefStores): Desk {
  return readPref(choices, DESK_PURPOSE, DESK_KEY, parseDesk, stores) ?? EMPTY_DESK;
}

export function saveDesk(choices: Choices, desk: Desk, stores?: PrefStores): WriteResult {
  return writePref(choices, DESK_PURPOSE, DESK_KEY, parseDesk(desk) ?? EMPTY_DESK, stores);
}

export function toggleTray(desk: Desk, avatarId: string): Desk {
  if (!AVATAR_IDS.has(avatarId)) return desk;
  if (desk.tray.includes(avatarId)) return { ...desk, tray: desk.tray.filter((id) => id !== avatarId) };
  return { ...desk, tray: [...desk.tray, avatarId].slice(-TRAY_SIZE) };
}

export function forgetDesk(stores?: PrefStores): void {
  removePref(DESK_KEY, stores);
}
