import { useEffect, useRef } from "react";
import { shouldLoopAB } from "@veil/features";
import { usePlayerStore } from "~/platform/player-store";

// The single <audio> element for the whole desktop. Lives in the layout so music keeps
// playing while the user moves between screens (feed, market, tools). The store holds the
// desired state; this component makes the element match it and reports events back.
export function PlayerAudio() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
  const failures = useRef(0);
  const current = usePlayerStore((s) => s.tracks[s.index]);
  // The File is the stable identity: metadata updates (duration, stars) replace the track
  // object and must not reload the element.
  const currentFile = current?.file;
  const playing = usePlayerStore((s) => s.playing);
  const rate = usePlayerStore((s) => s.rate);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const generation = usePlayerStore((s) => s.generation);

  // Point the element at the current file; revoke the previous object URL.
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
    failures.current = 0;
    const url = URL.createObjectURL(current.file);
    urlRef.current = url;
    audio.src = url;
    if (usePlayerStore.getState().playing) {
      void audio.play().catch(() => usePlayerStore.getState().setPlaying(false));
    }
  }, [currentFile, generation]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing && current) {
      void audio.play().catch(() =>
        usePlayerStore.getState().setNote("This browser blocked playback. Tap Play again."),
      );
    } else {
      audio.pause();
    }
  }, [playing, current]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, current]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.muted = muted;
    }
  }, [volume, muted, current]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && seekTo !== null) {
      audio.currentTime = seekTo;
      usePlayerStore.getState().clearSeek();
    }
  }, [seekTo]);

  // Lock screen / headset controls, and the title shown there. Best effort: not every browser has it.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const store = usePlayerStore.getState();
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({ title: current.title, artist: "Everybody is Cool", album: store.playlistName ?? "Local folder" })
      : null;
    navigator.mediaSession.setActionHandler("play", () => store.setPlaying(true));
    navigator.mediaSession.setActionHandler("pause", () => store.setPlaying(false));
    navigator.mediaSession.setActionHandler("nexttrack", () => store.move(1, false));
    navigator.mediaSession.setActionHandler("previoustrack", () => store.move(-1, false));
    return () => {
      for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [current]);

  return (
    <audio
      ref={audioRef}
      data-testid="player"
      className="hidden"
      onPlay={() => usePlayerStore.getState().setPlaying(true)}
      onPause={() => usePlayerStore.getState().setPlaying(false)}
      onEnded={() => usePlayerStore.getState().onEnded()}
      onPlaying={() => {
        failures.current = 0;
        const audio = audioRef.current;
        const store = usePlayerStore.getState();
        const track = store.tracks[store.index];
        if (audio && track && track.duration === null && Number.isFinite(audio.duration)) {
          store.setDuration(store.index, audio.duration);
        }
      }}
      onTimeUpdate={() => {
        const audio = audioRef.current;
        if (!audio) return;
        const store = usePlayerStore.getState();
        if (shouldLoopAB(store.abA, store.abB, audio.currentTime)) {
          audio.currentTime = store.abA!;
          return;
        }
        store.tick(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
      }}
      onError={() => {
        const store = usePlayerStore.getState();
        failures.current += 1;
        if (failures.current >= Math.max(1, store.tracks.length)) {
          store.setPlaying(false);
          store.setNote("None of these files could be played by this browser.");
          return;
        }
        const title = store.tracks[store.index]?.title ?? "a file";
        store.setNote(`Skipped "${title}": this browser can't play it.`);
        store.move(1, true);
      }}
    />
  );
}
