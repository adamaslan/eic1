import { describe, expect, it } from "vitest";
import { isAudioFile, orderTracks, stepIndex, trackTitle } from "./music";

describe("music playlist", () => {
  it("keeps audio and drops everything else, including ._ files", () => {
    const files = [
      { name: "a.mp3", type: "audio/mpeg" },
      { name: "b.MP3", type: "" },
      { name: "cover.jpg", type: "image/jpeg" },
      { name: "._a.mp3", type: "audio/mpeg" },
      { name: "notes.txt", type: "text/plain" },
    ];
    expect(orderTracks(files).map((f) => f.name)).toEqual(["a.mp3", "b.MP3"]);
    expect(isAudioFile({ name: "x.flac", type: "" })).toBe(true);
  });

  it("orders by folder path with natural numbers", () => {
    const files = ["album/10 ten.mp3", "album/2 two.mp3", "album/1 one.mp3"].map((path) => ({
      name: path.split("/")[1]!,
      type: "audio/mpeg",
      path,
    }));
    expect(orderTracks(files).map((f) => f.name)).toEqual(["1 one.mp3", "2 two.mp3", "10 ten.mp3"]);
  });

  it("titles drop the extension only", () => {
    expect(trackTitle("my.song.v2.mp3")).toBe("my.song.v2");
    expect(trackTitle("plain")).toBe("plain");
  });

  it("loops the whole folder, wrapping at both ends", () => {
    expect(stepIndex(3, 0, 1, "all", true)).toBe(1);
    expect(stepIndex(3, 2, 1, "all", true)).toBe(0);
    expect(stepIndex(3, 0, -1, "all", false)).toBe(2);
  });

  it("repeat one replays on auto end but moves on a tap", () => {
    expect(stepIndex(3, 1, 1, "one", true)).toBe(1);
    expect(stepIndex(3, 1, 1, "one", false)).toBe(2);
  });

  it("repeat off stops after the last track and handles empty lists", () => {
    expect(stepIndex(3, 2, 1, "off", true)).toBeNull();
    expect(stepIndex(3, 2, 1, "off", false)).toBe(0);
    expect(stepIndex(0, 0, 1, "all", true)).toBeNull();
    expect(stepIndex(1, 0, 1, "all", true)).toBe(0);
  });
});

import { shuffleOrder } from "./music";
describe("shuffleOrder", () => {
  it("is a permutation that starts at the current track", () => {
    const order = shuffleOrder(6, 3, () => 0.3);
    expect(order[0]).toBe(3);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(shuffleOrder(0, 0)).toEqual([]);
  });
});
