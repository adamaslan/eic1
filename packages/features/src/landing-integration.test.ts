import { describe, expect, it } from "vitest";
import { createChallenge, submitLayout, revealChallenge, revealedGallery } from "./index";

describe("landing merge preserves main sticker-remix public exports", () => {
  it("keeps the public challenge workflow reachable through the package barrel", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    let challenge = createChallenge({id: "integration", hostId: "a", players: ["a", "b"], theme: "landing", allowedStickers: ["star"], now});
    const layout = [{sticker: "star" as const, x: 0.5, y: 0.5, scale: 1, rotation: 0}];
    challenge = submitLayout(challenge, "a", layout, now);
    challenge = submitLayout(challenge, "b", layout, now);
    const revealed = revealChallenge(challenge, "a", now);
    expect(revealedGallery(revealed)).toHaveLength(2);
  });
  it("keeps finite-coordinate rejection when imported through the package barrel", () => {
    const challenge = createChallenge({id: "finite", hostId: "a", players: ["a", "b"], theme: "landing", allowedStickers: ["star"], now: new Date("2026-11-08T12:00:00Z")});
    expect(() => submitLayout(challenge, "b", [{sticker: "star", x: Infinity, y: 0.5, scale: 1, rotation: 0}], new Date("2026-11-08T12:00:00Z"))).toThrow();
    expect(challenge.layouts).toEqual({});
  });
});
