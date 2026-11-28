import type { Choices } from "./cookie-jar-store";
import { readPref, removePref, writePref, type PrefStores, type WriteResult } from "./local-pref";

// Cassette bookmark (proposal feature 2): where you stopped. Tracks are local Files the person
// picks again each visit, so the bookmark stores a hash of the folder-relative path and a time -
// never a title, file name or folder name. It never resumes sound by itself (browser autoplay
// rules, and the person decides).

export const CASSETTE_KEY = "eic.cassette.v1";
export const CASSETTE_PURPOSE = "cassette-bookmark";
export const SAVE_EVERY_SECONDS = 5;

export interface Bookmark {
  pathHash: string;
  seconds: number;
  side: "A" | "B";
}

/** FNV-1a: not security, just a way to match a path later without storing the path. */
export function hashPath(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function parseBookmark(raw: unknown): Bookmark | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.pathHash !== "string" || !/^[0-9a-f]{8}$/.test(value.pathHash)) return null;
  if (typeof value.seconds !== "number" || !Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 24 * 3600) return null;
  return { pathHash: value.pathHash, seconds: Math.floor(value.seconds), side: value.side === "B" ? "B" : "A" };
}

/** Pure: should a tick write? Throttled so storage is not hit on every audio event. */
export function shouldSave(previousSeconds: number | null, seconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds < 1) return false;
  return previousSeconds === null || Math.abs(seconds - previousSeconds) >= SAVE_EVERY_SECONDS;
}

/** Pure: find the track a bookmark points at among freshly picked files. */
export function matchTrack(bookmark: Bookmark | null, tracks: ReadonlyArray<{ path: string; duration: number | null }>): { index: number; seconds: number } | null {
  if (!bookmark) return null;
  const index = tracks.findIndex((track) => hashPath(track.path) === bookmark.pathHash);
  if (index < 0) return null;
  const duration = tracks[index].duration;
  // A bookmark past the end (file changed) would seek into nothing; start over instead.
  if (duration !== null && bookmark.seconds >= duration) return null;
  return { index, seconds: bookmark.seconds };
}

export function loadBookmark(choices: Choices, stores?: PrefStores): Bookmark | null {
  return readPref(choices, CASSETTE_PURPOSE, CASSETTE_KEY, parseBookmark, stores);
}

export function saveBookmark(choices: Choices, bookmark: Bookmark, stores?: PrefStores): WriteResult {
  return writePref(choices, CASSETTE_PURPOSE, CASSETTE_KEY, bookmark, stores);
}

export function forgetBookmark(stores?: PrefStores): void {
  removePref(CASSETTE_KEY, stores);
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
