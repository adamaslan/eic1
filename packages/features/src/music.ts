// Pure playlist logic for the local music player. Nothing here touches the network or the vault:
// the player only ever sees File objects the user picked, and keeps them in memory.

export type RepeatMode = "all" | "one" | "off";

export interface PickedFile {
  name: string;
  type: string;
  /** Folder-relative path from a folder pick (webkitRelativePath); empty for loose files. */
  path?: string;
}

const AUDIO_EXTENSION = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba)$/i;

/** True for audio the browser can usually decode. MP3 is the target; others are best effort. */
export function isAudioFile(file: PickedFile): boolean {
  if (file.name.startsWith(".")) return false; // macOS ._ resource-fork files
  return file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name);
}

/** Display title: file name without extension. */
export function trackTitle(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Keeps audio only, ordered by folder path then name, with "2" before "10". */
export function orderTracks<T extends PickedFile>(files: readonly T[]): T[] {
  return files
    .filter(isAudioFile)
    .sort((a, b) => collator.compare(a.path || a.name, b.path || b.name));
}

/**
 * Index to play after `index` finishes (direction 1) or on "previous" (direction -1).
 * Returns null when playback should stop (repeat off, end of list). Repeat "one" only repeats
 * on natural track end (`auto`); an explicit next/previous tap still moves.
 */
export function stepIndex(
  length: number,
  index: number,
  direction: 1 | -1,
  mode: RepeatMode,
  auto: boolean,
): number | null {
  if (length <= 0) return null;
  if (auto && mode === "one") return index;
  const next = index + direction;
  if (next >= 0 && next < length) return next;
  if (mode === "off" && auto) return null;
  return (next + length) % length;
}

/** Random play order that starts at `first` (Fisher-Yates on the rest). `random` is injectable for tests. */
export function shuffleOrder(length: number, first: number, random: () => number = Math.random): number[] {
  const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return length > 0 ? [first, ...rest] : [];
}

// --- Speeds ---------------------------------------------------------------

/** Playback speeds offered by the Speed menu. 1x is the natural rate. */
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** "m:ss" for list and strip display; "--:--" when duration is unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- List editing ---------------------------------------------------------

/** Moves the item at `from` one position in `direction` (-1 up, +1 down); clamps at the ends. */
export function moveTrack<T>(list: readonly T[], from: number, direction: 1 | -1): T[] {
  const to = from + direction;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Removes the items at the given indexes (order-independent). */
export function removeTracks<T>(list: readonly T[], indexes: readonly number[]): T[] {
  const drop = new Set(indexes);
  return list.filter((_, i) => !drop.has(i));
}

/** Filters by title substring (case-insensitive); empty query returns all indexes. */
export function filterIndexes(titles: readonly string[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return titles.map((_, i) => i);
  const out: number[] = [];
  titles.forEach((t, i) => {
    if (t.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}

/** Sorts indexes by title or duration; "reverse" flips the current order. */
export function sortIndexes(
  titles: readonly string[],
  durations: readonly (number | null)[],
  mode: "name" | "duration" | "reverse",
): number[] {
  const idx = titles.map((_, i) => i);
  if (mode === "reverse") return idx.reverse();
  if (mode === "duration") {
    return idx.sort((a, b) => (durations[a] ?? Infinity) - (durations[b] ?? Infinity));
  }
  return idx.sort((a, b) => collator.compare(titles[a]!, titles[b]!));
}

// --- Play-next queue ------------------------------------------------------

/** Adds an index to the queue unless it is already queued. */
export function enqueue(queue: readonly number[], index: number): number[] {
  return queue.includes(index) ? [...queue] : [...queue, index];
}

/** Pops the head of the queue; returns [next, rest] or [null, queue] when empty. */
export function dequeue(queue: readonly number[]): [number | null, number[]] {
  if (queue.length === 0) return [null, []];
  return [queue[0]!, queue.slice(1)];
}

// --- A-B repeat ------------------------------------------------------------

/** True when the playhead is at/past B and should jump back to A. Only valid A < B pairs count. */
export function shouldLoopAB(a: number | null, b: number | null, currentTime: number): boolean {
  return a != null && b != null && b > a && currentTime >= b;
}

// --- Saved playlists (metadata only) --------------------------------------
//
// A saved playlist never contains audio: it remembers names, order, durations and stars, and
// the player matches freshly picked files back onto it by folder path, then by bare name.

import { z } from "zod";

export const PLAYLIST_FORMAT = "eic-playlist";
export const PLAYLIST_VERSION = 1;
export const MAX_PLAYLIST_NAME = 60;
export const MAX_PLAYLIST_TRACKS = 2000;

const savedTrack = z.object({
  name: z.string().min(1),
  path: z.string().default(""),
  durationSeconds: z.number().nonnegative().nullable().default(null),
  starred: z.boolean().default(false),
});

export const SavedPlaylistSchema = z.object({
  format: z.literal(PLAYLIST_FORMAT),
  version: z.literal(PLAYLIST_VERSION),
  name: z.string().min(1).max(MAX_PLAYLIST_NAME),
  savedAt: z.iso.datetime(),
  tracks: z.array(savedTrack).max(MAX_PLAYLIST_TRACKS),
});
export type SavedPlaylist = z.infer<typeof SavedPlaylistSchema>;
export type SavedTrack = z.infer<typeof savedTrack>;

/** Identity used for matching a picked file back onto a saved track: folder path, else name. */
export function trackKey(file: { name?: string; path?: string }): string {
  return (file.path || file.name || "").toLowerCase();
}

export interface MatchResult {
  /** Picked indexes in saved-playlist order; null where the saved track was not re-picked. */
  mapping: (number | null)[];
  missing: string[];
}

/** Matches freshly picked files onto a saved playlist. Extra picked files are ignored. */
export function matchSavedToPicked(saved: SavedPlaylist, picked: readonly PickedFile[]): MatchResult {
  const byKey = new Map<string, number>();
  picked.forEach((file, i) => {
    const key = trackKey(file);
    if (!byKey.has(key)) byKey.set(key, i);
  });
  const mapping: (number | null)[] = [];
  const missing: string[] = [];
  for (const track of saved.tracks) {
    const hit = byKey.get(trackKey(track));
    if (hit == null) {
      mapping.push(null);
      missing.push(track.name);
    } else {
      mapping.push(hit);
    }
  }
  return { mapping, missing };
}

// --- Play counts (local stats, stored with the playlist metadata) ----------

/** Increments the play count for a track key; returns a new map. */
export function bumpPlayCount(counts: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

// --- eic-music share bundle manifest --------------------------------------
//
// The manifest rides inside a store-only ZIP next to the audio bytes (see zip-store.ts), or is
// shared as playlist.json alongside the raw files through the native share sheet. It never
// contains audio itself.

export const MUSIC_BUNDLE_FORMAT = "eic-music";
export const MUSIC_BUNDLE_VERSION = 1;
export const MUSIC_MANIFEST_NAME = "playlist.json";
/** Decoded-audio cap for one bundle; keeps a share inside what messaging apps will carry. */
export const MAX_MUSIC_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_MUSIC_BUNDLE_TRACKS = 200;
/** playlist.json cap inside a bundle or picked loose; guards against junk payloads. */
export const MAX_MUSIC_MANIFEST_BYTES = 1024 * 1024;

export const MusicManifestSchema = z.object({
  format: z.literal(MUSIC_BUNDLE_FORMAT),
  version: z.literal(MUSIC_BUNDLE_VERSION),
  name: z.string().min(1).max(MAX_PLAYLIST_NAME),
  exportedAt: z.iso.datetime(),
  tracks: z
    .array(
      z.object({
        file: z.string().min(1),
        title: z.string().min(1),
        durationSeconds: z.number().nonnegative().nullable().default(null),
      }),
    )
    .min(1)
    .max(MAX_MUSIC_BUNDLE_TRACKS),
});
export type MusicManifest = z.infer<typeof MusicManifestSchema>;

/** Sum of audio bytes a bundle would carry, for the honest pre-share size check. */
export function bundleBytes(sizes: readonly number[]): number {
  return sizes.reduce((sum, n) => sum + n, 0);
}
