// Pure playlist logic for the local music player. Nothing here touches the network or the vault:
// the player only ever sees File objects the user picked, and keeps them in memory.

export type RepeatMode = "all" | "one" | "off";

export interface PickedFile {
  name: string;
  type: string;
  /** Folder-relative path from a folder pick (webkitRelativePath); empty for loose files. */
  path?: string;
}

const AUDIO_EXTENSION = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

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
