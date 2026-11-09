import { describe, expect, it } from "vitest";
import { findManifestFileIndex } from "./music";

describe("manifest filename matching", () => {
  it("does not attach a longer file name that only shares the suffix", () => {
    expect(findManifestFileIndex([{ name: "banana.mp3" }], "03-a.mp3")).toBe(-1);
  });

  it("prefers an exact name match", () => {
    expect(findManifestFileIndex([{ name: "01-other.mp3" }, { name: "song.mp3" }], "song.mp3")).toBe(1);
  });

  it("matches a complete prefix-stripped name", () => {
    expect(findManifestFileIndex([{ name: "07-song.mp3" }], "song.mp3")).toBe(0);
  });

  it("does not match when only part of the stripped name agrees", () => {
    expect(findManifestFileIndex([{ name: "the-song.mp3" }], "song.mp3")).toBe(-1);
  });
});
