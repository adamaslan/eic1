import { describe, expect, it } from "vitest";
import {
  MAX_LAYOUT_BYTES,
  MAX_PLACEMENTS,
  createChallenge,
  layoutBytes,
  revealChallenge,
  revealedGallery,
  submitLayout,
  type Placement,
  type StickerChallenge,
} from "./sticker-remix";

const NOW = new Date("2026-11-08T12:00:00Z");
const PLAYERS = ["ana", "ben", "cy"];

function openChallenge(allowed: Array<"star" | "heart" | "flower" | "smile"> = ["star", "heart"]): StickerChallenge {
  return createChallenge({ id: "c1", hostId: "ana", players: PLAYERS, theme: "under the sea", allowedStickers: allowed, now: NOW });
}

const PLACE: Placement = { sticker: "star", x: 0.3, y: 0.4, scale: 1, rotation: 0 };

describe("createChallenge", () => {
  it("opens a collecting challenge with a trimmed theme", () => {
    const challenge = createChallenge({ id: "c", hostId: "ana", players: PLAYERS, theme: "  picnic  ", allowedStickers: ["star"], now: NOW });
    expect(challenge.status).toBe("collecting");
    expect(challenge.theme).toBe("picnic");
    expect(challenge.layouts).toEqual({});
  });

  it("enforces two to six players, unique, with the host among them", () => {
    const base = { id: "c", hostId: "ana", theme: "t", allowedStickers: ["star" as const], now: NOW };
    expect(() => createChallenge({ ...base, players: ["ana"] })).toThrow(/two to six/i);
    expect(() => createChallenge({ ...base, players: ["ana", "ana"] })).toThrow(/unique/i);
    expect(() => createChallenge({ ...base, players: ["ben", "cy"] })).toThrow(/host/i);
    expect(() => createChallenge({ ...base, players: ["ana", "b", "c", "d", "e", "f", "g"] })).toThrow(/two to six/i);
  });

  it("requires at least one allowed sticker and rejects unknown ones", () => {
    expect(() => createChallenge({ id: "c", hostId: "ana", players: PLAYERS, theme: "t", allowedStickers: [], now: NOW })).toThrow(/at least one/i);
    expect(() =>
      createChallenge({ id: "c", hostId: "ana", players: PLAYERS, theme: "t", allowedStickers: ["unicorn" as never], now: NOW }),
    ).toThrow(/built-in/i);
  });

  it("refuses an empty or over-long theme", () => {
    const base = { id: "c", hostId: "ana", players: PLAYERS, allowedStickers: ["star" as const], now: NOW };
    expect(() => createChallenge({ ...base, theme: "   " })).toThrow(/theme/i);
    expect(() => createChallenge({ ...base, theme: "x".repeat(41) })).toThrow(/40/);
  });
});

describe("submitLayout", () => {
  it("stores a layout that references only allowed sticker kinds", () => {
    const challenge = submitLayout(openChallenge(), "ben", [PLACE], NOW);
    expect(challenge.layouts.ben.placements).toEqual([PLACE]);
  });

  it("lets a player replace their layout before reveal", () => {
    const first = submitLayout(openChallenge(), "ben", [PLACE], NOW);
    const second = submitLayout(first, "ben", [{ ...PLACE, x: 0.9 }], NOW);
    expect(second.layouts.ben.placements[0].x).toBe(0.9);
    expect(Object.keys(second.layouts)).toHaveLength(1);
  });

  it("refuses a sticker the participants are not allowed to use", () => {
    expect(() => submitLayout(openChallenge(["star"]), "ben", [{ ...PLACE, sticker: "heart" }], NOW)).toThrow(/not allowed/i);
  });

  it("refuses non-players", () => {
    expect(() => submitLayout(openChallenge(), "mallory", [PLACE], NOW)).toThrow(/player/i);
  });

  it("refuses an empty layout and too many placements", () => {
    expect(() => submitLayout(openChallenge(), "ben", [], NOW)).toThrow(/at least one/i);
    const many = Array.from({ length: MAX_PLACEMENTS + 1 }, () => PLACE);
    expect(() => submitLayout(openChallenge(), "ben", many, NOW)).toThrow(/at most/i);
  });

  it("clamps coordinates into the canvas and rejects out-of-range scale", () => {
    const challenge = submitLayout(openChallenge(), "ben", [{ ...PLACE, x: 5, y: -2 }], NOW);
    const placed = challenge.layouts.ben.placements[0];
    expect(placed.x).toBe(0.95);
    expect(placed.y).toBe(0.05);
    expect(() => submitLayout(openChallenge(), "ben", [{ ...PLACE, scale: 9 }], NOW)).toThrow(/scale/i);
  });

  it.each(["x", "y", "rotation"] as const)("rejects non-finite %s without changing the challenge", (field) => {
    const challenge = openChallenge();
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => submitLayout(challenge, "ben", [{ ...PLACE, [field]: value }], NOW)).toThrow(/finite/i);
      expect(challenge.layouts).toEqual({});
    }
  });

  it("keeps each layout within the 2 KiB ceiling", () => {
    const challenge = submitLayout(openChallenge(), "ben", [PLACE], NOW);
    expect(layoutBytes(challenge.layouts.ben)).toBeLessThanOrEqual(MAX_LAYOUT_BYTES);
  });

  it("counts the stored timestamp toward the 2 KiB ceiling", () => {
    const base = { playerId: "", placements: [PLACE], submittedAt: NOW.toISOString() };
    const playerId = "x".repeat(MAX_LAYOUT_BYTES - layoutBytes(base) + 1);
    const challenge = createChallenge({
      id: "large-layout",
      hostId: "ana",
      players: ["ana", playerId],
      theme: "under the sea",
      allowedStickers: ["star"],
      now: NOW,
    });
    expect(() => submitLayout(challenge, playerId, [PLACE], NOW)).toThrow(/too large/i);
  });

  it("refuses layouts after reveal", () => {
    const revealed = revealChallenge(submitLayout(openChallenge(), "ben", [PLACE], NOW), "ana", NOW);
    expect(() => submitLayout(revealed, "cy", [PLACE], NOW)).toThrow(/revealed/i);
  });
});

describe("revealChallenge", () => {
  it("only the host can reveal, and needs at least one layout", () => {
    const withLayout = submitLayout(openChallenge(), "ben", [PLACE], NOW);
    expect(() => revealChallenge(withLayout, "ben", NOW)).toThrow(/host/i);
    expect(() => revealChallenge(openChallenge(), "ana", NOW)).toThrow(/at least one layout/i);
    expect(revealChallenge(withLayout, "ana", NOW).status).toBe("revealed");
  });

  it("gallery is hidden until reveal, then lists every layout in player order", () => {
    let challenge = submitLayout(openChallenge(), "cy", [PLACE], NOW);
    challenge = submitLayout(challenge, "ben", [{ ...PLACE, sticker: "heart" }], NOW);
    expect(() => revealedGallery(challenge)).toThrow(/reveal/i);
    const gallery = revealedGallery(revealChallenge(challenge, "ana", NOW));
    expect(gallery.map((entry) => entry.playerId)).toEqual(["ben", "cy"]);
  });

  it("does not treat inherited object properties as submitted player layouts", () => {
    const challenge = createChallenge({
      id: "prototype-key",
      hostId: "ana",
      players: ["ana", "toString"],
      theme: "under the sea",
      allowedStickers: ["star"],
      now: NOW,
    });
    const withLayout = submitLayout(challenge, "ana", [PLACE], NOW);
    const gallery = revealedGallery(revealChallenge(withLayout, "ana", NOW));
    expect(gallery.map((entry) => entry.playerId)).toEqual(["ana"]);
  });
});
