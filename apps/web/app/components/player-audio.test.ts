import { describe, expect, it } from "vitest";
import { isStalePlayRejection } from "./player-audio";
import type { PlayerTrack } from "~/platform/player-store";

function track(id: string): PlayerTrack {
  return { id, title: id, file: new File([id], `${id}.mp3`, { type: "audio/mpeg" }), path: "", duration: null, starred: false };
}

describe("stale play() rejection guard", () => {
  it("ignores a rejection from a skipped track after the queue advanced", () => {
    const a = track("a");
    const b = track("b");
    expect(isStalePlayRejection({ tracks: [a, b], index: 1 }, a.file)).toBe(true);
  });

  it("accepts a rejection that still belongs to the current track", () => {
    const a = track("a");
    expect(isStalePlayRejection({ tracks: [a], index: 0 }, a.file)).toBe(false);
  });

  it("treats a rejection as stale when the queue is empty", () => {
    const a = track("a");
    expect(isStalePlayRejection({ tracks: [], index: 0 }, a.file)).toBe(true);
  });
});
