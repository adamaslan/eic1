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

import {
  PLAYBACK_SPEEDS,
  SavedPlaylistSchema,
  bumpPlayCount,
  bundleBytes,
  dequeue,
  enqueue,
  filterIndexes,
  formatDuration,
  matchSavedToPicked,
  moveTrack,
  MusicManifestSchema,
  removeTracks,
  shouldLoopAB,
  sortIndexes,
} from "./music";
import { buildZip, readZip, zipCrc32 } from "./zip-store";

describe("playback speeds", () => {
  it("offers the expanded menu around 1x", () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });
});

describe("formatDuration", () => {
  it("formats m:ss and tolerates unknown durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(61.9)).toBe("1:01");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(null)).toBe("--:--");
    expect(formatDuration(NaN)).toBe("--:--");
  });
});

describe("list editing", () => {
  it("moves tracks with clamping at both ends", () => {
    expect(moveTrack(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveTrack(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveTrack(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveTrack(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("removes multiple tracks order-independently", () => {
    expect(removeTracks(["a", "b", "c", "d"], [3, 1])).toEqual(["a", "c"]);
    expect(removeTracks(["a"], [])).toEqual(["a"]);
  });

  it("filters and sorts without touching the source order", () => {
    const titles = ["Beta", "alpha", "Gamma"];
    expect(filterIndexes(titles, "a")).toEqual([0, 1, 2]);
    expect(filterIndexes(titles, "bet")).toEqual([0]);
    expect(filterIndexes(titles, "")).toEqual([0, 1, 2]);
    expect(sortIndexes(titles, [null, null, null], "name")).toEqual([1, 0, 2]);
    expect(sortIndexes(titles, [30, 10, 20], "duration")).toEqual([1, 2, 0]);
    expect(sortIndexes(titles, [null, null, null], "reverse")).toEqual([2, 1, 0]);
  });
});

describe("play-next queue", () => {
  it("queues without duplicates and pops in order", () => {
    let q = enqueue([], 2);
    q = enqueue(q, 2);
    q = enqueue(q, 5);
    expect(q).toEqual([2, 5]);
    const [next, rest] = dequeue(q);
    expect(next).toBe(2);
    expect(rest).toEqual([5]);
    expect(dequeue(rest)).toEqual([5, []]);
    expect(dequeue([])).toEqual([null, []]);
  });
});

describe("A-B repeat", () => {
  it("only loops a valid A < B pair at or past B", () => {
    expect(shouldLoopAB(3, 10, 10.01)).toBe(true);
    expect(shouldLoopAB(3, 10, 9.99)).toBe(false);
    expect(shouldLoopAB(null, 10, 20)).toBe(false);
    expect(shouldLoopAB(10, 3, 20)).toBe(false);
  });
});

describe("saved playlists", () => {
  const saved = SavedPlaylistSchema.parse({
    format: "eic-playlist",
    version: 1,
    name: "Gym",
    savedAt: new Date().toISOString(),
    tracks: [
      { name: "2 two.mp3", path: "gym/2 two.mp3", durationSeconds: 95 },
      { name: "10 ten.mp3", path: "gym/10 ten.mp3" },
      { name: "gone.mp3", path: "" },
    ],
  });

  it("matches re-picked files by path, reports missing honestly", () => {
    const { mapping, missing } = matchSavedToPicked(saved, [
      { name: "10 ten.mp3", type: "audio/mpeg", path: "gym/10 ten.mp3" },
      { name: "2 two.mp3", type: "audio/mpeg", path: "gym/2 two.mp3" },
    ]);
    expect(mapping).toEqual([1, 0, null]);
    expect(missing).toEqual(["gone.mp3"]);
  });

  it("matches loose files by bare name, case-insensitively", () => {
    const loose = SavedPlaylistSchema.parse({ ...saved, tracks: [{ name: "Song.MP3", path: "" }] });
    const { mapping } = matchSavedToPicked(loose, [{ name: "song.mp3", type: "audio/mpeg" }]);
    expect(mapping).toEqual([0]);
  });

  it("rejects oversized or wrong-format metadata", () => {
    expect(SavedPlaylistSchema.safeParse({ format: "nope" }).success).toBe(false);
  });
});

describe("play counts", () => {
  it("bumps without mutating", () => {
    const once = bumpPlayCount({}, "a.mp3");
    const twice = bumpPlayCount(once, "a.mp3");
    expect(once).toEqual({ "a.mp3": 1 });
    expect(twice).toEqual({ "a.mp3": 2 });
  });
});

describe("music bundle manifest", () => {
  it("round-trips and refuses empty bundles", () => {
    const manifest = MusicManifestSchema.parse({
      format: "eic-music",
      version: 1,
      name: "Mix",
      exportedAt: new Date().toISOString(),
      tracks: [{ file: "01 song.mp3", title: "song" }],
    });
    expect(manifest.tracks[0]!.durationSeconds).toBeNull();
    expect(MusicManifestSchema.safeParse({ ...manifest, tracks: [] }).success).toBe(false);
  });

  it("sums bundle bytes for the pre-share check", () => {
    expect(bundleBytes([10, 20, 30])).toBe(60);
  });
});

describe("store-only zip", () => {
  it("round-trips entries byte-exact with crc checks", () => {
    const a = new TextEncoder().encode("playlist json here");
    const b = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const zip = buildZip([
      { name: "playlist.json", data: a },
      { name: "audio/01 song.mp3", data: b },
    ]);
    const out = readZip(zip);
    expect(out.map((e) => e.name)).toEqual(["playlist.json", "audio/01 song.mp3"]);
    expect([...out[0]!.data]).toEqual([...a]);
    expect([...out[1]!.data]).toEqual([...b]);
  });

  it("rejects tampered data, unsafe names and non-zips", () => {
    const zip = buildZip([{ name: "a.bin", data: new Uint8Array([1, 2, 3]) }]);
    const tampered = zip.slice();
    tampered[35]! ^= 0xff; // flip a data byte after the 30-byte header + 5-byte name
    expect(() => readZip(tampered)).toThrow(/Damaged/);
    expect(() => buildZip([{ name: "../evil", data: new Uint8Array(1) }])).toThrow(/Unsafe/);
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("crc32 matches the known check value", () => {
    expect(zipCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
