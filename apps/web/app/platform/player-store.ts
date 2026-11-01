import { create } from "zustand";
import {
  bumpPlayCount,
  dequeue,
  enqueue,
  isAudioFile,
  orderTracks,
  shuffleOrder,
  stepIndex,
  trackKey,
  trackTitle,
  type RepeatMode,
} from "@veil/features";

// The one persistent player. The <audio> element lives in the desktop layout so playback
// survives navigation (feed now-playing strip), and every screen reads state from here.
// Files are still only the user's picked File objects: never uploaded, never written to
// the vault, forgotten on full page close (playlists re-link fresh picks; see playlists.ts).

export interface PlayerTrack {
  id: string;
  title: string;
  file: File;
  /** Folder-relative path when picked as a folder; used to re-link saved playlists. */
  path: string;
  duration: number | null;
  starred: boolean;
}

export type SleepMode = "off" | "track" | "15" | "30" | "60";

interface PlayerState {
  tracks: PlayerTrack[];
  index: number;
  playing: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  order: number[];
  autoNext: boolean;
  queue: number[];
  rate: number;
  volume: number;
  muted: boolean;
  sleep: SleepMode;
  sleepEndsAt: number | null;
  stopAfterCurrent: boolean;
  abA: number | null;
  abB: number | null;
  currentTime: number;
  duration: number;
  note: string;
  playlistName: string | null;
  playCounts: Record<string, number>;
  /** Bumped when the track list is replaced, so stale async work can bail. */
  generation: number;

  loadFiles: (files: File[], opts?: { playlistName?: string | null; keepOrder?: boolean }) => void;
  replaceTracks: (tracks: PlayerTrack[], opts?: { playlistName?: string | null; startIndex?: number; autoplay?: boolean }) => void;
  playAt: (index: number) => void;
  setPlaying: (playing: boolean) => void;
  move: (direction: 1 | -1, auto: boolean) => void;
  onEnded: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  setAutoNext: (on: boolean) => void;
  playNext: (index: number) => void;
  reorderTrack: (from: number, direction: 1 | -1) => void;
  applyOrder: (indexes: number[]) => void;
  removeTrack: (index: number) => void;
  clearTracks: () => void;
  toggleStar: (index: number) => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setSleep: (mode: SleepMode) => void;
  setStopAfterCurrent: (on: boolean) => void;
  cycleAB: () => void;
  tick: (currentTime: number, duration: number) => void;
  setDuration: (index: number, duration: number) => void;
  setNote: (note: string) => void;
  /** Lock / vault switch: drops every private trace - files, names, counts, position. */
  resetAll: () => void;
  setPlaylistName: (name: string | null) => void;
  seekTo: number | null;
  requestSeek: (seconds: number) => void;
  clearSeek: () => void;
}

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { all: "one", one: "off", off: "all" };

function toTrack(file: File, i: number): PlayerTrack {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
  return { id: `${i}-${file.name}`, title: trackTitle(file.name), file, path, duration: null, starred: false };
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  tracks: [],
  index: 0,
  playing: false,
  repeat: "all",
  shuffle: false,
  order: [],
  autoNext: true,
  queue: [],
  rate: 1,
  volume: 1,
  muted: false,
  sleep: "off",
  sleepEndsAt: null,
  stopAfterCurrent: false,
  abA: null,
  abB: null,
  currentTime: 0,
  duration: 0,
  note: "",
  playlistName: null,
  playCounts: {},
  generation: 0,
  seekTo: null,

  loadFiles: (files, opts) => {
    const ordered = orderTracks(
      files.filter(isAudioFile).map((file) =>
        Object.assign(file, { path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || "" }),
      ),
    );
    const skipped = files.length - ordered.length;
    set((state) => ({
      tracks: ordered.map(toTrack),
      index: 0,
      playing: false,
      queue: [],
      order: [],
      shuffle: false,
      abA: null,
      abB: null,
      currentTime: 0,
      duration: 0,
      playlistName: opts?.playlistName ?? null,
      generation: state.generation + 1,
      note:
        ordered.length === 0
          ? "No audio files found in that selection."
          : skipped > 0
            ? `${skipped} non-audio file${skipped === 1 ? "" : "s"} skipped.`
            : "",
    }));
  },

  replaceTracks: (tracks, opts) =>
    set((state) => ({
      tracks,
      index: Math.min(opts?.startIndex ?? 0, Math.max(0, tracks.length - 1)),
      playing: false,
      queue: [],
      order: [],
      shuffle: false,
      abA: null,
      abB: null,
      currentTime: 0,
      duration: 0,
      playlistName: opts?.playlistName ?? null,
      generation: state.generation + 1,
      note: "",
    })),

  playAt: (index) => {
    if (index < 0 || index >= get().tracks.length) return;
    set({ index, currentTime: 0 });
  },

  setPlaying: (playing) => set({ playing }),

  move: (direction, auto) => {
    const { tracks, index, repeat, shuffle, order, autoNext, queue, stopAfterCurrent } = get();
    if (tracks.length === 0) return;
    if (auto && (stopAfterCurrent || (!autoNext && repeat !== "one"))) {
      set({ playing: false });
      return;
    }
    if (queue.length > 0 && (direction === 1 || !auto)) {
      const [next, rest] = dequeue(queue);
      if (next !== null && next < tracks.length) {
        set({ queue: rest, index: next, currentTime: 0, playing: true });
        return;
      }
      set({ queue: rest });
    }
    const sequence = shuffle && order.length === tracks.length ? order : null;
    const at = sequence ? sequence.indexOf(index) : index;
    const stepped = stepIndex(tracks.length, at, direction, repeat, auto);
    const next = stepped === null ? null : sequence ? sequence[stepped]! : stepped;
    if (next === null) {
      set({ playing: false });
      return;
    }
    if (next === index) {
      set({ currentTime: 0, seekTo: 0, playing: true });
      return;
    }
    set({ index: next, currentTime: 0, playing: true });
  },

  onEnded: () => {
    const { tracks, index, playCounts, sleep, move } = get();
    const track = tracks[index];
    if (track) set({ playCounts: bumpPlayCount(playCounts, trackKey(track)) });
    if (sleep === "track") {
      set({ playing: false, sleep: "off", sleepEndsAt: null });
      return;
    }
    move(1, true);
  },

  cycleRepeat: () => set((s) => ({ repeat: NEXT_REPEAT[s.repeat] })),

  toggleShuffle: () =>
    set((s) => ({ shuffle: !s.shuffle, order: !s.shuffle ? shuffleOrder(s.tracks.length, s.index) : [] })),

  setAutoNext: (on) => set({ autoNext: on }),

  playNext: (index) => set((s) => ({ queue: enqueue(s.queue, index), note: `Queued "${s.tracks[index]?.title ?? "track"}" to play next.` })),

  reorderTrack: (from, direction) => {
    const { tracks, index } = get();
    const to = from + direction;
    if (to < 0 || to >= tracks.length) return;
    const next = [...tracks];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    // Keep the now-playing pointer on the same track.
    let newIndex = index;
    if (index === from) newIndex = to;
    else if (index === to) newIndex = from;
    set({ tracks: next, index: newIndex, order: [], shuffle: false });
  },

  applyOrder: (indexes) => {
    const { tracks, index } = get();
    if (indexes.length !== tracks.length) return;
    const current = tracks[index];
    const next = indexes.map((i) => tracks[i]!);
    const newIndex = current ? next.findIndex((t) => t.id === current.id) : 0;
    set({ tracks: next, index: newIndex < 0 ? 0 : newIndex, order: [], shuffle: false });
  },

  removeTrack: (index) => {
    const { tracks, index: current } = get();
    if (index < 0 || index >= tracks.length) return;
    const next = tracks.filter((_, i) => i !== index);
    set({
      tracks: next,
      index: next.length === 0 ? 0 : index < current ? current - 1 : Math.min(current, next.length - 1),
      playing: next.length === 0 ? false : index === current ? false : get().playing,
      order: [],
      shuffle: false,
    });
  },

  clearTracks: () =>
    set((s) => ({
      tracks: [],
      index: 0,
      playing: false,
      queue: [],
      order: [],
      shuffle: false,
      abA: null,
      abB: null,
      playlistName: null,
      generation: s.generation + 1,
      note: "",
    })),

  toggleStar: (index) =>
    set((s) => ({ tracks: s.tracks.map((t, i) => (i === index ? { ...t, starred: !t.starred } : t)) })),

  setRate: (rate) => set({ rate }),
  setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
  setMuted: (muted) => set({ muted }),

  setSleep: (mode) =>
    set({
      sleep: mode,
      sleepEndsAt: mode === "off" || mode === "track" ? null : Date.now() + Number(mode) * 60_000,
    }),

  setStopAfterCurrent: (on) => set({ stopAfterCurrent: on }),

  cycleAB: () => {
    const { abA, abB, currentTime } = get();
    if (abA === null) set({ abA: currentTime, abB: null, note: `A set at ${Math.floor(currentTime)}s. Tap A-B again at the end of the loop.` });
    else if (abB === null) {
      if (currentTime > abA) set({ abB: currentTime, note: "Looping A-B. Tap A-B again to clear." });
      else set({ note: "B must be after A." });
    } else set({ abA: null, abB: null, note: "A-B loop cleared." });
  },

  tick: (currentTime, duration) => {
    const { sleep, sleepEndsAt, playing } = get();
    if (sleepEndsAt !== null && playing && Date.now() >= sleepEndsAt) {
      set({ playing: false, sleep: "off", sleepEndsAt: null, note: "Sleep timer stopped playback.", currentTime, duration });
      return;
    }
    set({ currentTime, duration });
  },

  setDuration: (index, duration) =>
    set((s) => ({ tracks: s.tracks.map((t, i) => (i === index ? { ...t, duration } : t)) })),

  setNote: (note) => set({ note }),

  resetAll: () =>
    set((s) => ({
      tracks: [],
      index: 0,
      playing: false,
      queue: [],
      order: [],
      shuffle: false,
      abA: null,
      abB: null,
      currentTime: 0,
      duration: 0,
      note: "",
      playlistName: null,
      playCounts: {},
      seekTo: null,
      sleep: "off",
      sleepEndsAt: null,
      stopAfterCurrent: false,
      generation: s.generation + 1,
    })),
  setPlaylistName: (name) => set({ playlistName: name }),
  requestSeek: (seconds) => set({ seekTo: seconds }),
  clearSeek: () => set({ seekTo: null }),
}));
