import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  MAX_MUSIC_BUNDLE_BYTES,
  MAX_MUSIC_MANIFEST_BYTES,
  MAX_PLAYLIST_NAME,
  MUSIC_BUNDLE_FORMAT,
  MUSIC_BUNDLE_VERSION,
  MUSIC_MANIFEST_NAME,
  MusicManifestSchema,
  PLAYBACK_SPEEDS,
  SavedPlaylistSchema,
  buildZip,
  bundleBytes,
  filterIndexes,
  formatDuration,
  listPlaylists,
  matchSavedToPicked,
  readZip,
  renamePlaylist,
  deletePlaylist,
  saveMusicSession,
  loadMusicSession,
  savePlaylist,
  sortIndexes,
  trackKey,
  type RepeatMode,
  type SavedPlaylist,
} from "@veil/features";
import type { Route } from "./+types/music";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { usePlayerStore, type PlayerTrack, type SleepMode } from "~/platform/player-store";
import { useSessionStore } from "~/platform/session";
import { COMPRESS_BITRATES, compressAudio, estimateCompressedBytes, pickCompressTarget } from "~/platform/audio-compress";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Music — Everybody is Cool" }];
}

const REPEAT_LABEL: Record<RepeatMode, string> = { all: "Loop: folder", one: "Loop: song", off: "Loop: off" };

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  weba: "audio/webm",
};

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Builds the share manifest; entry names are order-prefixed so bundles keep the playlist order. */
function buildManifest(name: string, tracks: readonly PlayerTrack[]) {
  return MusicManifestSchema.parse({
    format: MUSIC_BUNDLE_FORMAT,
    version: MUSIC_BUNDLE_VERSION,
    name,
    exportedAt: new Date().toISOString(),
    tracks: tracks.map((t, i) => ({
      file: `${String(i + 1).padStart(2, "0")}-${t.file.name}`,
      title: t.title,
      durationSeconds: t.duration,
    })),
  });
}

export default function Music() {
  const store = usePlayerStore();
  const vault = useSessionStore((s) => s.vault);
  const current = store.tracks[store.index];

  const [showList, setShowList] = useState(true);
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState<SavedPlaylist[]>([]);
  const [saveName, setSaveName] = useState("");
  const [resumeHint, setResumeHint] = useState<string | null>(null);
  const [showShrink, setShowShrink] = useState(false);
  const [bitrate, setBitrate] = useState<number>(128_000);
  const [shrinking, setShrinking] = useState<number | null>(null);
  const [shrinkProgress, setShrinkProgress] = useState(0);
  const [shrunk, setShrunk] = useState<Record<number, PlayerTrack>>({});
  const [originals, setOriginals] = useState<Record<number, PlayerTrack>>({});
  const [sharing, setSharing] = useState(false);

  const openPickRef = useRef<HTMLInputElement>(null);
  const pendingOpenRef = useRef<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const durationScan = useRef(0);

  const refreshSaved = useCallback(async () => {
    if (!vault) return;
    try {
      setSaved(await listPlaylists(vault));
    } catch {
      store.setNote("Saved playlists could not be read from the vault.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  // Resume hint: what was playing last time (the audio itself is never stored).
  useEffect(() => {
    if (!vault || store.tracks.length > 0) return;
    void loadMusicSession(vault).then((session) => {
      if (session) {
        setResumeHint(
          `Last time: "${session.playlistName}" stopped at ${session.trackName} (${formatDuration(session.positionSeconds)}). Open that playlist to pick up there.`,
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  // Remember where playback stopped, so a reopen can offer resume. Metadata only.
  useEffect(() => {
    if (!vault || !current || store.playing) return;
    void saveMusicSession(vault, {
      format: "eic-music-session",
      version: 1,
      playlistName: store.playlistName ?? "Picked songs",
      trackName: current.file.name,
      positionSeconds: store.currentTime,
      savedAt: new Date().toISOString(),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, store.playing, current?.id]);

  // Keep the now-playing row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [store.index, filter]);

  // Keyboard shortcuts while this screen is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        if (current) store.setPlaying(!store.playing);
      } else if (event.key === "ArrowRight") store.requestSeek(store.currentTime + 10);
      else if (event.key === "ArrowLeft") store.requestSeek(Math.max(0, store.currentTime - 10));
      else if (event.key.toLowerCase() === "n") store.move(1, false);
      else if (event.key.toLowerCase() === "p") store.move(-1, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, store.playing, store.currentTime]);

  function load(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    setShrunk({});
    setOriginals({});
    store.loadFiles(picked);
  }

  // Lazily read durations with one off-screen element, a few files at a time.
  function readDurations() {
    const scanId = ++durationScan.current;
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    const pending = store.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.duration === null);
    let pos = 0;
    store.setNote(pending.length === 0 ? "All track lengths are known." : `Reading ${pending.length} track lengths…`);
    const step = () => {
      if (durationScan.current !== scanId) return;
      const next = pending[pos++];
      if (!next) {
        store.setNote("Track lengths are in.");
        return;
      }
      const url = URL.createObjectURL(next.t.file);
      probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        usePlayerStore.getState().setDuration(next.i, probe.duration);
        step();
      };
      probe.onerror = () => {
        URL.revokeObjectURL(url);
        step();
      };
      probe.src = url;
    };
    step();
  }

  async function onSave() {
    if (!vault || store.tracks.length === 0) return;
    const name = saveName.trim() || store.playlistName || "";
    if (!name) {
      store.setNote("Name the playlist first.");
      return;
    }
    if (name.length > MAX_PLAYLIST_NAME) {
      store.setNote(`Keep the name under ${MAX_PLAYLIST_NAME} characters.`);
      return;
    }
    try {
      await savePlaylist(
        vault,
        SavedPlaylistSchema.parse({
          format: "eic-playlist",
          version: 1,
          name,
          savedAt: new Date().toISOString(),
          tracks: store.tracks.map((t) => ({
            name: t.file.name,
            path: t.path,
            durationSeconds: t.duration,
            starred: t.starred,
          })),
        }),
      );
      store.setPlaylistName(name);
      store.setNote(`Saved "${name}" - the list, not the songs. Your device keeps the audio.`);
      setSaveName("");
      await refreshSaved();
    } catch (err) {
      store.setNote(err instanceof Error ? err.message : "Could not save that playlist.");
    }
  }

  function startOpen(name: string) {
    pendingOpenRef.current = name;
    openPickRef.current?.click();
  }

  async function onOpenPicked(event: ChangeEvent<HTMLInputElement>) {
    const name = pendingOpenRef.current;
    pendingOpenRef.current = null;
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!name || !vault || picked.length === 0) return;
    const playlist = saved.find((p) => p.name === name);
    if (!playlist) return;
    const { mapping, missing } = matchSavedToPicked(playlist, picked);
    const tracks: PlayerTrack[] = [];
    playlist.tracks.forEach((savedTrack, savedIndex) => {
      const pickedIndex = mapping[savedIndex];
      if (pickedIndex === null) return;
      const file = picked[pickedIndex]!;
      tracks.push({
        id: `${savedIndex}-${file.name}`,
        title: savedTrack.name.replace(/\.[^./\\]+$/, ""),
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || savedTrack.path,
        duration: savedTrack.durationSeconds,
        starred: savedTrack.starred,
      });
    });
    if (tracks.length === 0) {
      store.setNote(`None of the songs in "${name}" were in that selection. Pick the files the playlist lists.`);
      return;
    }
    store.replaceTracks(tracks, { playlistName: name });
    setShrunk({});
    setOriginals({});
    // Resume where this playlist stopped, when we know.
    const session = await loadMusicSession(vault);
    if (session && session.playlistName === name) {
      const at = tracks.findIndex((t) => t.file.name === session.trackName);
      if (at >= 0) {
        store.playAt(at);
        store.requestSeek(session.positionSeconds);
        store.setNote(`Resumed "${name}" at ${formatDuration(session.positionSeconds)}.${missing.length ? ` ${missing.length} song(s) not re-picked.` : ""}`);
        return;
      }
    }
    store.setNote(
      missing.length > 0
        ? `Opened "${name}" without ${missing.length} song(s): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`
        : `Opened "${name}".`,
    );
  }

  async function onRename(name: string) {
    if (!vault) return;
    const to = window.prompt(`Rename "${name}" to:`, name);
    if (!to || to.trim() === name) return;
    try {
      await renamePlaylist(vault, name, to.trim());
      if (store.playlistName === name) store.setPlaylistName(to.trim());
      await refreshSaved();
    } catch (err) {
      store.setNote(err instanceof Error ? err.message : "Could not rename that playlist.");
    }
  }

  async function onDelete(name: string) {
    if (!vault) return;
    if (!window.confirm(`Delete the saved playlist "${name}"? The songs on your device are not touched.`)) return;
    await deletePlaylist(vault, name);
    if (store.playlistName === name) store.setPlaylistName(null);
    await refreshSaved();
  }

  async function onShare() {
    if (store.tracks.length === 0 || sharing) return;
    const total = bundleBytes(store.tracks.map((t) => t.file.size));
    if (total > MAX_MUSIC_BUNDLE_BYTES) {
      store.setNote(
        `This playlist is ${formatBytes(total)} of audio - over the ${formatBytes(MAX_MUSIC_BUNDLE_BYTES)} share limit. Remove songs or shrink them below.`,
      );
      return;
    }
    setSharing(true);
    try {
      const name = store.playlistName ?? "eic playlist";
      const manifest = buildManifest(name, store.tracks);
      const manifestText = JSON.stringify(manifest, null, 2);
      const renamed = store.tracks.map(
        (t, i) => new File([t.file], `${String(i + 1).padStart(2, "0")}-${t.file.name}`, { type: t.file.type || mimeFor(t.file.name) }),
      );
      const files = [new File([manifestText], MUSIC_MANIFEST_NAME, { type: "application/json" }), ...renamed];
      const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (typeof nav.share === "function" && nav.canShare?.({ files })) {
        // Native share sheet: AirDrop, Messages, Save to Files - chosen and sent by the user.
        await nav.share({ files, title: name, text: `Playlist "${name}" from Everybody is Cool. Import it in eic → Music.` });
        store.setNote("Shared. Nothing was uploaded - it went through your own share sheet.");
      } else {
        const entries = [{ name: MUSIC_MANIFEST_NAME, data: new TextEncoder().encode(manifestText) }];
        for (const f of renamed) entries.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
        const bundle = buildZip(entries);
        const url = URL.createObjectURL(new Blob([bundle.buffer as ArrayBuffer], { type: "application/zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "playlist"}.eicmusic`;
        link.click();
        URL.revokeObjectURL(url);
        store.setNote("Downloaded one .eicmusic file. Send it with any app you like; nothing was uploaded.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        store.setNote("Share cancelled.");
      } else {
        store.setNote(err instanceof Error ? err.message : "Sharing failed.");
      }
    } finally {
      setSharing(false);
    }
  }

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    try {
      let manifestRaw: string | null = null;
      let audioFiles: File[] = [];
      const bundle = picked.find((f) => /\.(eicmusic|zip)$/i.test(f.name));
      if (bundle && bundle.size > MAX_MUSIC_BUNDLE_BYTES + MAX_MUSIC_MANIFEST_BYTES + 4096) {
        throw new Error(`That bundle is ${formatBytes(bundle.size)} - bigger than the ${formatBytes(MAX_MUSIC_BUNDLE_BYTES)} share limit.`);
      }
      if (bundle) {
        const entries = readZip(new Uint8Array(await bundle.arrayBuffer()));
        const manifestEntry = entries.find((e) => e.name === MUSIC_MANIFEST_NAME);
        if (!manifestEntry) throw new Error("That bundle has no playlist.json.");
        if (manifestEntry.data.length > MAX_MUSIC_MANIFEST_BYTES) throw new Error("That playlist.json is too large to be a playlist.");
        manifestRaw = new TextDecoder().decode(manifestEntry.data);
        audioFiles = entries
          .filter((e) => e.name !== MUSIC_MANIFEST_NAME)
          .map((e) => new File([e.data.buffer as ArrayBuffer], e.name.split("/").pop()!, { type: mimeFor(e.name) }));
        const names = audioFiles.map((f) => f.name);
        if (new Set(names).size !== names.length) throw new Error("That bundle has duplicate file names and cannot be trusted.");
      } else {
        const json = picked.find((f) => f.name === MUSIC_MANIFEST_NAME || /\.json$/i.test(f.name));
        if (json && json.size > MAX_MUSIC_MANIFEST_BYTES) throw new Error("That playlist.json is too large to be a playlist.");
        if (json) manifestRaw = await json.text();
        audioFiles = picked.filter((f) => f !== json);
      }
      if (!manifestRaw) {
        // Plain audio picks: treat as a normal load.
        store.loadFiles(picked);
        return;
      }
      const manifest = MusicManifestSchema.parse(JSON.parse(manifestRaw));
      const tracks: PlayerTrack[] = [];
      const missing: string[] = [];
      const pool = [...audioFiles];
      manifest.tracks.forEach((entry, i) => {
        const at = pool.findIndex((f) => f.name === entry.file);
        const looseAt = at < 0 ? pool.findIndex((f) => f.name.endsWith(entry.file.replace(/^\d+-/, ""))) : -1;
        const file = at >= 0 ? pool[at] : looseAt >= 0 ? pool[looseAt] : undefined;
        if (at >= 0) pool.splice(at, 1);
        if (looseAt >= 0) pool.splice(looseAt, 1);
        if (!file) {
          missing.push(entry.title);
          return;
        }
        tracks.push({ id: `${i}-${file.name}`, title: entry.title, file, path: "", duration: entry.durationSeconds, starred: false });
      });
      if (tracks.length === 0) {
        store.setNote("None of the songs in that shared playlist came through.");
        return;
      }
      store.replaceTracks(tracks, { playlistName: manifest.name });
      setShrunk({});
      setOriginals({});
      store.setNote(
        missing.length
          ? `Imported "${manifest.name}" without ${missing.length} missing song(s).`
          : `Imported "${manifest.name}" - ${tracks.length} song(s) ready to play.`,
      );
    } catch (err) {
      store.setNote(err instanceof Error ? err.message : "That shared playlist could not be read.");
    }
  }

  async function onShrink(index: number) {
    const track = store.tracks[index];
    if (!track || shrinking !== null) return;
    setShrinking(index);
    setShrinkProgress(0);
    try {
      const { file, originalBytes } = await compressAudio(track.file, {
        bitsPerSecond: bitrate,
        onProgress: setShrinkProgress,
      });
      setShrunk((prev) => ({ ...prev, [index]: { ...track, file, title: track.title } }));
      store.setNote(
        `Shrunk "${track.title}" from ${formatBytes(originalBytes)} to ${formatBytes(file.size)}. The original is untouched.`,
      );
    } catch (err) {
      store.setNote(err instanceof Error ? err.message : "Could not shrink that song.");
    } finally {
      setShrinking(null);
    }
  }

  function applyShrunk(index: number) {
    const replacement = shrunk[index];
    if (!replacement) return;
    const tracks = [...store.tracks];
    // The original File stays recoverable via "Original" until the list changes.
    setOriginals((prev) => ({ ...prev, [index]: tracks[index]! }));
    tracks[index] = { ...replacement, starred: tracks[index]!.starred };
    store.replaceTracks(tracks, { playlistName: store.playlistName, startIndex: store.index });
    setShrunk((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  function revertToOriginal(index: number) {
    const original = originals[index];
    if (!original) return;
    const tracks = [...store.tracks];
    tracks[index] = original;
    store.replaceTracks(tracks, { playlistName: store.playlistName, startIndex: store.index });
    setOriginals((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  function downloadFile(file: File) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  const titles = store.tracks.map((t) => t.title);
  const durations = store.tracks.map((t) => t.duration);
  const visible = filterIndexes(titles, filter);
  const knownDurations = durations.filter((d): d is number => d !== null);
  const totalBytes = bundleBytes(store.tracks.map((t) => t.file.size));
  const compressTarget = pickCompressTarget();
  const queuedTitles = store.queue.map((i) => store.tracks[i]?.title).filter(Boolean);

  return (
    <Window title={store.playlistName ? `Music Player — ${store.playlistName}` : "Music Player"}>
      <div className="flex flex-col gap-2 text-[12px]">
        <p className="text-[#404040]">
          Plays MP3, WAV and more from your device. Songs are never uploaded or copied into the vault: saved playlists
          remember the list only, and you pick the files again to play them.
        </p>
        <div className="flex flex-wrap gap-1">
          <label className="cursor-pointer">
            <span className="block min-h-[44px] bg-[#c0c0c0] px-3 py-2 text-[12px] shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] sm:min-h-0 sm:py-1">
              Choose folder…
            </span>
            <input
              type="file"
              className="sr-only"
              aria-label="Choose a music folder"
              // @ts-expect-error non-standard but widely supported folder picker
              webkitdirectory=""
              onChange={load}
            />
          </label>
          <label className="cursor-pointer">
            <span className="block min-h-[44px] bg-[#c0c0c0] px-3 py-2 text-[12px] shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] sm:min-h-0 sm:py-1">
              Choose files…
            </span>
            <input type="file" className="sr-only" aria-label="Choose music files" accept="audio/*,.mp3,.wav" multiple onChange={load} />
          </label>
          <Button95 onClick={() => importRef.current?.click()}>Import shared…</Button95>
          <input
            ref={importRef}
            type="file"
            className="sr-only"
            aria-label="Import a shared playlist"
            accept=".eicmusic,.zip,.json,audio/*"
            multiple
            onChange={(e) => void onImport(e)}
          />
          <Button95 onClick={() => void onShare()} disabled={store.tracks.length === 0 || sharing}>
            {sharing ? "Sharing…" : "Share playlist + songs"}
          </Button95>
        </div>
        {store.tracks.length > 0 && (
          <p className="text-[#404040]">
            {store.tracks.length} track{store.tracks.length === 1 ? "" : "s"}
            {knownDurations.length > 0 && <> · {formatDuration(knownDurations.reduce((a, b) => a + b, 0))} total</>} ·{" "}
            {formatBytes(totalBytes)} of audio
            {totalBytes > MAX_MUSIC_BUNDLE_BYTES && (
              <span className="text-[#800000]"> (over the {formatBytes(MAX_MUSIC_BUNDLE_BYTES)} share limit)</span>
            )}
          </p>
        )}

        <div data-testid="track-display" className="bg-black px-2 py-1 font-mono text-[#00ff00]" aria-live="polite">
          {current ? `${store.index + 1}/${store.tracks.length}  ${current.title}` : "No folder loaded"}
        </div>

        {/* Seek bar */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]">{formatDuration(store.currentTime)}</span>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={Math.max(1, Math.floor(store.duration || current?.duration || 1))}
            value={Math.floor(store.currentTime)}
            onChange={(e) => store.requestSeek(Number(e.target.value))}
            className="min-w-0 flex-1"
            disabled={!current}
          />
          <span className="font-mono text-[11px]">{formatDuration(store.duration || current?.duration)}</span>
        </div>

        <div className="flex flex-wrap gap-1">
          <Button95 onClick={() => store.move(-1, false)} disabled={!current} aria-label="Previous track">
            ⏮ Prev
          </Button95>
          <Button95 onClick={() => store.setPlaying(!store.playing)} disabled={!current}>
            {store.playing ? "⏸ Pause" : "▶ Play"}
          </Button95>
          <Button95 onClick={() => store.move(1, false)} disabled={!current} aria-label="Next track">
            Next ⏭
          </Button95>
          <Button95 onClick={store.cycleRepeat} pressed={store.repeat !== "off"}>
            {REPEAT_LABEL[store.repeat]}
          </Button95>
          <Button95 onClick={store.cycleAB} disabled={!current} pressed={store.abA !== null}>
            {store.abB !== null ? "A-B ✓" : store.abA !== null ? "A…" : "A-B"}
          </Button95>
          <Button95 onClick={() => store.setStopAfterCurrent(!store.stopAfterCurrent)} pressed={store.stopAfterCurrent} disabled={!current}>
            Stop after track
          </Button95>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Player options">
          <Button95 onClick={store.toggleShuffle} pressed={store.shuffle} disabled={store.tracks.length < 2}>
            Shuffle
          </Button95>
          <Button95 onClick={() => store.setAutoNext(!store.autoNext)} pressed={store.autoNext}>
            Auto-next
          </Button95>
          <Button95 onClick={() => setShowList(!showList)} pressed={showList}>
            Playlist
          </Button95>
          <label className="flex items-center gap-1">
            Speed
            <select
              aria-label="Playback speed"
              value={store.rate}
              onChange={(e) => store.setRate(Number(e.target.value))}
              className="bg-white px-1 py-0.5 text-[12px]"
            >
              {PLAYBACK_SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Sleep
            <select
              aria-label="Sleep timer"
              value={store.sleep}
              onChange={(e) => store.setSleep(e.target.value as SleepMode)}
              className="bg-white px-1 py-0.5 text-[12px]"
            >
              <option value="off">Off</option>
              <option value="track">End of track</option>
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <button
              type="button"
              aria-label={store.muted ? "Unmute" : "Mute"}
              onClick={() => store.setMuted(!store.muted)}
              className="min-h-[24px] min-w-[28px] bg-[#c0c0c0] shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] active:shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
            >
              {store.muted || store.volume === 0 ? "🔇" : "🔊"}
            </button>
            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={100}
              value={Math.round(store.volume * 100)}
              onChange={(e) => store.setVolume(Number(e.target.value) / 100)}
            />
          </label>
        </div>

        {queuedTitles.length > 0 && <p className="text-[#404040]">Up next: {queuedTitles.join(" → ")}</p>}
        {store.note && (
          <p role="status" className="text-[#800000]">
            {store.note}
          </p>
        )}
        {resumeHint && store.tracks.length === 0 && <p className="text-[#000080]">{resumeHint}</p>}

        {/* Saved playlists (metadata only) */}
        <div className="border-2 border-b-[#dfdfdf] border-r-[#dfdfdf] border-l-[#0a0a0a] border-t-[#0a0a0a] bg-[#c0c0c0] p-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <input
              aria-label="Playlist name"
              placeholder="Playlist name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              maxLength={MAX_PLAYLIST_NAME}
              className="min-w-0 flex-1 bg-white px-1.5 py-1 text-[12px] sm:w-[160px] sm:flex-none"
            />
            <Button95 onClick={() => void onSave()} disabled={store.tracks.length === 0}>
              Save playlist
            </Button95>
          </div>
          {saved.length > 0 && (
            <ul aria-label="Saved playlists" className="mt-1 bg-white">
              {saved.map((p) => (
                <li key={p.name} className="flex items-center gap-1 border-b border-[#dfdfdf] px-1 py-0.5">
                  <span className="min-w-0 flex-1 truncate">
                    {p.name} <span className="text-[#404040]">({p.tracks.length})</span>
                  </span>
                  <Button95 onClick={() => startOpen(p.name)}>Open…</Button95>
                  <Button95 onClick={() => void onRename(p.name)}>Rename</Button95>
                  <Button95 onClick={() => void onDelete(p.name)}>Delete</Button95>
                </li>
              ))}
            </ul>
          )}
          <input ref={openPickRef} type="file" className="sr-only" aria-label="Pick the songs for this playlist" accept="audio/*,.mp3,.wav" multiple onChange={(e) => void onOpenPicked(e)} />
        </div>

        {/* Shrink (on-device compression) */}
        <div>
          <Button95 onClick={() => setShowShrink(!showShrink)} pressed={showShrink}>
            Shrink songs…
          </Button95>
          {showShrink && (
            <div className="mt-1 border-2 border-b-[#dfdfdf] border-r-[#dfdfdf] border-l-[#0a0a0a] border-t-[#0a0a0a] bg-[#c0c0c0] p-1.5">
              {!compressTarget ? (
                <p role="alert">This browser cannot re-encode audio. Try Chrome, Edge or Safari 14.1 or later.</p>
              ) : (
                <>
                  <p className="text-[#404040]">
                    Converts on this device to {compressTarget.label}. Smaller files trade a little sound quality -
                    lossy, not transparent; the estimate shows before you commit. Nothing is uploaded and your
                    original files are never changed: "Use" swaps the playlist to the smaller copy and "Original"
                    swaps it back, this session. Whether the receiver can play the smaller copy depends on their
                    browser - if it does not play for them, share the original files instead. Encoding runs in
                    realtime - a 3-minute song takes about 3 minutes.
                  </p>
                  <label className="mt-1 flex items-center gap-1">
                    Quality
                    <select aria-label="Compression quality" value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} className="bg-white px-1 py-0.5 text-[12px]">
                      {COMPRESS_BITRATES.map((b) => (
                        <option key={b.bits} value={b.bits}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul aria-label="Shrink songs" className="mt-1 bg-white">
                    {store.tracks.map((t, i) => {
                      const done = shrunk[i];
                      const estimate = t.duration ? estimateCompressedBytes(t.duration, bitrate) : null;
                      return (
                        <li key={t.id} className="flex flex-wrap items-center gap-1 border-b border-[#dfdfdf] px-1 py-0.5">
                          <span className="min-w-0 flex-1 truncate">
                            {t.title} <span className="text-[#404040]">({formatBytes(t.file.size)})</span>
                          </span>
                          {originals[i] ? (
                            <>
                              <span className="text-[#404040]">(shrunk copy in use)</span>
                              <Button95 onClick={() => revertToOriginal(i)}>Original</Button95>
                            </>
                          ) : done ? (
                            <>
                              <span className={done.file.size <= t.file.size ? "text-[#008000]" : "text-[#800000]"}>
                                → {formatBytes(done.file.size)}
                                {done.file.size > t.file.size ? " (bigger - not worth it)" : ""}
                              </span>
                              <Button95 onClick={() => applyShrunk(i)}>Use</Button95>
                              <Button95 onClick={() => downloadFile(done.file)}>Download</Button95>
                            </>
                          ) : shrinking === i ? (
                            <span aria-label="Shrinking">{Math.round(shrinkProgress * 100)}%</span>
                          ) : (
                            <Button95 onClick={() => void onShrink(i)} disabled={shrinking !== null}>
                              Convert{estimate ? ` (~${formatBytes(estimate)})` : ""}
                            </Button95>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {/* Track list */}
        {store.tracks.length > 0 && showList && (
          <div>
            <div className="flex flex-wrap items-center gap-1">
              <input
                type="search"
                aria-label="Filter playlist"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="min-w-0 flex-1 bg-white px-1.5 py-1 text-[12px] sm:w-[140px] sm:flex-none"
              />
              <label className="flex items-center gap-1">
                Order
                <select
                  aria-label="Sort playlist"
                  defaultValue="folder"
                  onChange={(e) => {
                    const mode = e.target.value;
                    if (mode === "folder") return;
                    store.applyOrder(sortIndexes(titles, durations, mode as "name" | "duration" | "reverse"));
                    e.target.value = "folder";
                  }}
                  className="bg-white px-1 py-0.5 text-[12px]"
                >
                  <option value="folder">Folder</option>
                  <option value="name">Name</option>
                  <option value="duration">Length</option>
                  <option value="reverse">Reverse</option>
                </select>
              </label>
              <Button95 onClick={readDurations}>Read lengths</Button95>
              <Button95
                onClick={() => {
                  if (window.confirm("Clear the whole playlist? Songs on your device are not touched.")) store.clearTracks();
                }}
              >
                Clear
              </Button95>
            </div>
            <ul ref={listRef} className="mt-1 max-h-[40vh] overflow-y-auto bg-white" aria-label="Playlist">
              {visible.map((i) => {
                const track = store.tracks[i]!;
                const plays = store.playCounts[trackKey(track)] ?? 0;
                return (
                  <li key={track.id} className="flex items-center">
                    <button
                      type="button"
                      aria-current={i === store.index ? "true" : undefined}
                      onClick={() => {
                        store.playAt(i);
                        store.setPlaying(true);
                      }}
                      className={`min-w-0 flex-1 truncate px-1.5 py-1 text-left min-h-[44px] sm:min-h-0 ${
                        i === store.index ? "bg-[#000080] text-white" : "text-[#0a0a0a]"
                      }`}
                    >
                      {i + 1}. {track.starred ? "★ " : ""}
                      {track.title}
                      <span className={i === store.index ? "text-[#c0c0c0]" : "text-[#404040]"}>
                        {" "}
                        {formatDuration(track.duration)}
                        {plays > 0 ? ` · played ${plays}×` : ""}
                      </span>
                    </button>
                    <span className={`flex shrink-0 ${i === store.index ? "bg-[#000080]" : ""}`}>
                      <Button95 aria-label={`Star ${track.title}`} pressed={track.starred} onClick={() => store.toggleStar(i)} className="min-h-0 min-w-[28px]">
                        {track.starred ? "★" : "☆"}
                      </Button95>
                      <Button95 aria-label={`Play ${track.title} next`} onClick={() => store.playNext(i)} className="min-h-0 min-w-[28px]">
                        ⏩
                      </Button95>
                      <Button95 aria-label={`Move ${track.title} up`} onClick={() => store.reorderTrack(i, -1)} className="min-h-0 min-w-[28px]">
                        ↑
                      </Button95>
                      <Button95 aria-label={`Move ${track.title} down`} onClick={() => store.reorderTrack(i, 1)} className="min-h-0 min-w-[28px]">
                        ↓
                      </Button95>
                      <Button95 aria-label={`Remove ${track.title}`} onClick={() => store.removeTrack(i)} className="min-h-0 min-w-[28px]">
                        ✕
                      </Button95>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-[#404040]">
          Sharing sends the actual songs plus a playlist.json through your own share sheet or as one .eicmusic file you
          send yourself - up to {formatBytes(MAX_MUSIC_BUNDLE_BYTES)} of audio. The receiver imports it in eic and plays
          the real files. Folder picking and playing with the screen locked depend on your browser and phone and are not
          verified on real phones: if the folder button does nothing, use "Choose files…".
        </p>
      </div>
    </Window>
  );
}
