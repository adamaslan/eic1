import { useEffect } from "react";
import { hashPath, loadBookmark, matchTrack, saveBookmark, shouldSave } from "./cassette-bookmark";
import { purposeEnabled, useCookieJarStore } from "./cookie-jar-store";
import { usePlayerStore } from "./player-store";

/**
 * Cassette bookmark wiring (proposal feature 2). Runs only while the person has switched
 * "Cassette bookmark" on (I-3): when it is off this hook subscribes to nothing and writes nothing.
 * It lines a picked track up at the saved time but never starts playback itself.
 * Loose files with no folder path are skipped: an empty path would match any loose file.
 */
export function useCassetteBookmark(active: boolean): void {
  const loaded = useCookieJarStore((s) => s.loaded);
  const enabled = useCookieJarStore((s) => purposeEnabled(s.choices, "cassette-bookmark"));
  const load = useCookieJarStore((s) => s.load);

  useEffect(() => { if (active && !loaded) load(); }, [active, loaded, load]);

  useEffect(() => {
    if (!active || !loaded || !enabled) return;
    let lastGeneration = -1;
    let lastSaved: number | null = null;
    return usePlayerStore.subscribe((state) => {
      const choices = useCookieJarStore.getState().choices;
      if (state.generation !== lastGeneration) {
        lastGeneration = state.generation;
        lastSaved = null;
        const hit = matchTrack(loadBookmark(choices), state.tracks.map((t) => ({ path: t.path, duration: t.duration })).map((t) => (t.path ? t : { ...t, path: "\u0000none" })));
        if (hit && state.tracks[hit.index]?.path) usePlayerStore.setState({ index: hit.index, seekTo: hit.seconds, currentTime: hit.seconds, playing: false });
        return;
      }
      const track = state.tracks[state.index];
      if (!track?.path || !shouldSave(lastSaved, state.currentTime)) return;
      lastSaved = state.currentTime;
      saveBookmark(choices, { pathHash: hashPath(track.path), seconds: state.currentTime, side: "A" });
    });
  }, [active, loaded, enabled]);
}
