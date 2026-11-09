import { describe, expect, it } from "vitest";
import { getSampleItems, sampleAuthorFor } from "./demo-items";
import { PROFILE_AVATARS } from "./profile-avatars";

const NOW = new Date("2026-11-07T12:00:00Z");

describe("sample authors for the landing feed examples", () => {
  it("gives every sample item a fictional author with a real drawn avatar", () => {
    const items = getSampleItems(NOW);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const author = sampleAuthorFor(item.id);
      expect(author, `sample author for ${item.id}`).not.toBeNull();
      expect(author!.handle).toMatch(/^[a-z0-9-]+$/);
      expect(PROFILE_AVATARS.some((avatar) => avatar.id === author!.avatarId)).toBe(true);
      expect(author!.avatarLabel.length).toBeGreaterThan(0);
      expect(author!.avatarData.length).toBeGreaterThan(0);
    }
  });

  it("keeps sample items authorless in the vault sense, so ownership checks are unaffected", () => {
    for (const item of getSampleItems(NOW)) {
      expect(item.authorId).toBeNull();
      expect(item.authorHandle).toBeNull();
    }
  });

  it("returns null for real item ids", () => {
    expect(sampleAuthorFor("post:alice:1")).toBeNull();
    expect(sampleAuthorFor("itm-1")).toBeNull();
    expect(sampleAuthorFor("")).toBeNull();
  });

  it("keeps @maya on the fog photo, matching the sample messages", () => {
    expect(sampleAuthorFor("demo-p1")?.handle).toBe("maya");
  });
});
