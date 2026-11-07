import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROFILE_AVATARS } from "@veil/features";

// Phone browsers (all iPhone browsers are WebKit) refuse to download data:
// URL anchors, so the stickers page links real static PNG files instead.
// These tests keep the checked-in files in sync with the avatar catalog.
const stickerPath = (id: string) => new URL(`../../public/stickers/eic-sticker-${id}.png`, import.meta.url);

describe("static sticker PNG files", () => {
  it("has a static PNG file for every catalog avatar", () => {
    expect(PROFILE_AVATARS.length).toBeGreaterThan(0);
    for (const avatar of PROFILE_AVATARS) {
      const file = readFileSync(stickerPath(avatar.id));
      expect(file.length).toBeGreaterThan(0);
    }
  });

  it("serves the exact avatar bytes, so stickers match in-app avatars", () => {
    for (const avatar of PROFILE_AVATARS) {
      const file = readFileSync(stickerPath(avatar.id));
      expect(file.equals(Buffer.from(avatar.data, "base64"))).toBe(true);
    }
  });

  it("serves valid 96 x 96 PNGs", () => {
    for (const avatar of PROFILE_AVATARS) {
      const file = readFileSync(stickerPath(avatar.id));
      expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(file.readUInt32BE(16)).toBe(96);
      expect(file.readUInt32BE(20)).toBe(96);
    }
  });
});
