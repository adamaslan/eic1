import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { orderTracks, shuffleOrder, stepIndex, trackTitle, type RepeatMode } from "@veil/features";
import type { Route } from "./+types/music";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Music — Everybody is Cool" }];
}

interface Track {
  id: string;
  title: string;
  file: File;
}

const REPEAT_LABEL: Record<RepeatMode, string> = { all: "Loop: folder", one: "Loop: song", off: "Loop: off" };
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { all: "one", one: "off", off: "all" };

// Files are played straight from the picked File objects through object URLs. They are never
// uploaded, never written to the vault or IndexedDB, and are forgotten when the page closes.
export default function Music() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
  const failures = useRef(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [repeat, setRepeat] = useState<RepeatMode>("all");
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState("");
  const wantPlay = useRef(false);
  const [shuffle, setShuffle] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const [showList, setShowList] = useState(true);
  const [rate, setRate] = useState(1);
  const [order, setOrder] = useState<number[]>([]);

  const current = tracks[index];

  // Point the single <audio> element at the current file; revoke the previous object URL.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    if (!current) {
      audio.removeAttribute("src");
      audio.load();
      return;
    }
    const url = URL.createObjectURL(current.file);
    urlRef.current = url;
    audio.src = url;
    if (wantPlay.current) void audio.play().catch(() => setPlaying(false));
  }, [current]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const move = useCallback(
    (direction: 1 | -1, auto: boolean) => {
      if (auto && !autoNext && repeat !== "one") {
        wantPlay.current = false;
        setPlaying(false);
        return;
      }
      const sequence = shuffle && order.length === tracks.length ? order : null;
      const at = sequence ? sequence.indexOf(index) : index;
      const stepped = stepIndex(tracks.length, at, direction, repeat, auto);
      const next = stepped === null ? null : sequence ? sequence[stepped]! : stepped;
      if (next === null) {
        wantPlay.current = false;
        setPlaying(false);
        return;
      }
      wantPlay.current = true;
      if (next === index) {
        // Same track again (repeat one, or a one-song folder): restart without reloading.
        const audio = audioRef.current;
        if (audio) {
          audio.currentTime = 0;
          void audio.play().catch(() => setPlaying(false));
        }
        return;
      }
      setIndex(next);
    },
    [tracks.length, index, repeat, shuffle, order, autoNext],
  );

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, current]);

  function toggleShuffle() {
    const on = !shuffle;
    setShuffle(on);
    setOrder(on ? shuffleOrder(tracks.length, index) : []);
  }

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      wantPlay.current = true;
      void audio.play().catch(() => setNote("This browser blocked playback. Tap Play again."));
    } else {
      wantPlay.current = false;
      audio.pause();
    }
  }, [current]);

  // Lock screen / headset controls, and the title shown there. Best effort: not every browser has it.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({ title: current.title, artist: "Everybody is Cool", album: "Local folder" })
      : null;
    navigator.mediaSession.setActionHandler("play", toggle);
    navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("nexttrack", () => move(1, false));
    navigator.mediaSession.setActionHandler("previoustrack", () => move(-1, false));
    return () => {
      for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [current, toggle, move]);

  function load(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    const ordered = orderTracks(
      picked.map((file) => Object.assign(file, { path: file.webkitRelativePath || "" })),
    );
    failures.current = 0;
    wantPlay.current = false;
    setPlaying(false);
    setIndex(0);
    setOrder([]);
    setShuffle(false);
    setTracks(ordered.map((file, i) => ({ id: `${i}-${file.name}`, title: trackTitle(file.name), file })));
    const skipped = picked.length - ordered.length;
    setNote(
      ordered.length === 0
        ? "No audio files found in that selection."
        : skipped > 0
          ? `${skipped} non-audio file${skipped === 1 ? "" : "s"} skipped.`
          : "",
    );
  }

  function onError() {
    // A file the browser can't decode: skip it, but stop if every track in a row fails.
    failures.current += 1;
    if (failures.current >= tracks.length) {
      wantPlay.current = false;
      setPlaying(false);
      setNote("None of these files could be played by this browser.");
      return;
    }
    setNote(`Skipped "${current?.title ?? "a file"}": this browser can't play it.`);
    move(1, true);
  }

  return (
    <Window title="Music Player">
      <div className="flex flex-col gap-2 text-[12px]">
        <p className="text-[#404040]">
          Plays MP3s from your device. Files are not uploaded or saved: pick them again after you close the page.
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
            <input
              type="file"
              className="sr-only"
              aria-label="Choose music files"
              accept="audio/*,.mp3"
              multiple
              onChange={load}
            />
          </label>
        </div>

        <div className="bg-black px-2 py-1 font-mono text-[#00ff00]" aria-live="polite">
          {current ? `${index + 1}/${tracks.length}  ${current.title}` : "No folder loaded"}
        </div>
        <audio
          ref={audioRef}
          data-testid="player"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => move(1, true)}
          onPlaying={() => (failures.current = 0)}
          onError={onError}
          controls
          className="w-full"
        />
        <div className="flex flex-wrap gap-1">
          <Button95 onClick={() => move(-1, false)} disabled={!current} aria-label="Previous track">
            ⏮ Prev
          </Button95>
          <Button95 onClick={toggle} disabled={!current}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </Button95>
          <Button95 onClick={() => move(1, false)} disabled={!current} aria-label="Next track">
            Next ⏭
          </Button95>
          <Button95 onClick={() => setRepeat(NEXT_REPEAT[repeat])} pressed={repeat !== "off"}>
            {REPEAT_LABEL[repeat]}
          </Button95>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Player options">
          <Button95 onClick={toggleShuffle} pressed={shuffle} disabled={tracks.length < 2}>
            Shuffle
          </Button95>
          <Button95 onClick={() => setAutoNext(!autoNext)} pressed={autoNext}>
            Auto-next
          </Button95>
          <Button95 onClick={() => setShowList(!showList)} pressed={showList}>
            Playlist
          </Button95>
          <Button95 onClick={() => setRate(rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 0.75 : 1)}>
            Speed {rate}x
          </Button95>
        </div>
        {note && <p role="status" className="text-[#800000]">{note}</p>}

        {tracks.length > 0 && showList && (
          <ul className="max-h-[40vh] overflow-y-auto bg-white" aria-label="Playlist">
            {tracks.map((track, i) => (
              <li key={track.id}>
                <button
                  type="button"
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => {
                    wantPlay.current = true;
                    if (i === index) {
                      const audio = audioRef.current;
                      if (audio) void audio.play().catch(() => setPlaying(false));
                    } else setIndex(i);
                  }}
                  className={`block min-h-[44px] w-full truncate px-1.5 py-1 text-left sm:min-h-0 ${
                    i === index ? "bg-[#000080] text-white" : "text-[#0a0a0a]"
                  }`}
                >
                  {i + 1}. {track.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[#404040]">
          Goes to the next song by itself and loops the folder unless you turn Loop off. Folder picking and playing with
          the screen locked depend on your browser and phone and are not verified on real phones: if the folder button
          does nothing, use "Choose files…".
        </p>
      </div>
    </Window>
  );
}
