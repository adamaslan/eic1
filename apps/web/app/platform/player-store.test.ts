import { afterEach, describe, expect, it } from "vitest";
import { usePlayerStore, type PlayerTrack } from "./player-store";

function track(id: string): PlayerTrack {
  return { id, title: id, file: new File([id], `${id}.mp3`, { type: "audio/mpeg" }), path: "", duration: null, starred: false };
}

afterEach(() => usePlayerStore.getState().resetAll());

describe("player queue identity", () => {
  it("keeps queued tracks attached through reorder and sort", () => {
    const store = usePlayerStore.getState();
    store.replaceTracks([track("a"), track("b"), track("c")]);
    store.playNext(1);
    store.reorderTrack(0, 1);
    expect(usePlayerStore.getState().queue).toEqual([0]);
    usePlayerStore.getState().applyOrder([2, 0, 1]);
    expect(usePlayerStore.getState().queue).toEqual([1]);
  });

  it("drops removed queued tracks and shifts the remaining indexes", () => {
    const store = usePlayerStore.getState();
    store.replaceTracks([track("a"), track("b"), track("c")]);
    store.playNext(1);
    store.playNext(2);
    store.removeTrack(0);
    expect(usePlayerStore.getState().queue).toEqual([0, 1]);
    usePlayerStore.getState().removeTrack(0);
    expect(usePlayerStore.getState().queue).toEqual([0]);
    usePlayerStore.getState().removeTrack(0);
    expect(usePlayerStore.getState().queue).toEqual([]);
  });

  it("replaces one audio file without stopping unrelated playback or clearing the queue", () => {
    const store = usePlayerStore.getState();
    store.replaceTracks([track("a"), track("b"), track("c")]);
    store.playNext(2);
    store.setPlaying(true);
    store.tick(12, 30);
    usePlayerStore.getState().replaceTrack(1, track("b-shrunk"));
    const state = usePlayerStore.getState();
    expect(state.playing).toBe(true);
    expect(state.index).toBe(0);
    expect(state.currentTime).toBe(12);
    expect(state.queue).toEqual([2]);
    expect(state.tracks[1]?.id).toBe("b-shrunk");
    usePlayerStore.getState().replaceTrack(0, track("a-shrunk"));
    expect(usePlayerStore.getState().playing).toBe(true);
    expect(usePlayerStore.getState().currentTime).toBe(0);
    expect(usePlayerStore.getState().queue).toEqual([2]);
  });
});
