import { describe, expect, it } from "vitest";
import { shouldSaveMusicSession } from "./music";

describe("music resume-record save guard", () => {
  it("does not overwrite the resume record at position 0 on a fresh pick", () => {
    expect(shouldSaveMusicSession({ playing: false, positionSeconds: 0 }, false)).toBe(false);
  });

  it("saves a real paused position", () => {
    expect(shouldSaveMusicSession({ playing: false, positionSeconds: 83 }, false)).toBe(true);
  });

  it("never saves while playing", () => {
    expect(shouldSaveMusicSession({ playing: true, positionSeconds: 83 }, false)).toBe(false);
  });

  it("does not overwrite a just-restored session before playback starts", () => {
    expect(shouldSaveMusicSession({ playing: false, positionSeconds: 42 }, true)).toBe(false);
  });
});
