import { describe, expect, it } from "vitest";
import {
  MAX_PLAYERS,
  MAX_SCENE_GRAPHEMES,
  MAX_TURNS,
  MAX_STORY_BYTES,
  createStory,
  finishStory,
  nextPlayerId,
  storyBytes,
  submitTurn,
  validateScene,
  type EmojiStory,
} from "./emoji-story";

const NOW = new Date("2026-11-08T12:00:00Z");
const PLAYERS = ["ana", "ben", "cy"];

function openStory(players = PLAYERS): EmojiStory {
  return createStory({ id: "s1", hostId: players[0], players, now: NOW });
}

describe("validateScene", () => {
  it("accepts a short emoji-only scene", () => {
    expect(validateScene("🐱🚀🌙")).toBe("🐱🚀🌙");
  });

  it("accepts emoji with skin tones, ZWJ sequences and spaces", () => {
    expect(validateScene("👍🏽 🏠")).toBe("👍🏽 🏠");
    expect(validateScene("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("rejects letters, digits and punctuation", () => {
    expect(() => validateScene("hello 🐱")).toThrow(/emoji/i);
    expect(() => validateScene("1🐱")).toThrow(/emoji/i);
    expect(() => validateScene("🐱!")).toThrow(/emoji/i);
  });

  it("rejects an empty or whitespace-only scene", () => {
    expect(() => validateScene("   ")).toThrow();
    expect(() => validateScene("")).toThrow();
  });

  it("caps a scene at MAX_SCENE_GRAPHEMES emoji", () => {
    expect(validateScene("🐱".repeat(MAX_SCENE_GRAPHEMES))).toHaveLength(MAX_SCENE_GRAPHEMES * 2);
    expect(() => validateScene("🐱".repeat(MAX_SCENE_GRAPHEMES + 1))).toThrow(/at most/i);
  });
});

describe("createStory", () => {
  it("starts an open story with the host as first player", () => {
    const story = openStory();
    expect(story.status).toBe("open");
    expect(story.turns).toEqual([]);
    expect(nextPlayerId(story)).toBe("ana");
  });

  it("rejects duplicate players and more than six players", () => {
    expect(() => openStory(["ana", "ana"])).toThrow(/unique|duplicate/i);
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    expect(seven.length).toBeGreaterThan(MAX_PLAYERS);
    expect(() => openStory(seven)).toThrow(/at most 6 players/i);
  });

  it("requires the host to be one of the players", () => {
    expect(() => createStory({ id: "s", hostId: "zed", players: PLAYERS, now: NOW })).toThrow(/host/i);
  });
});

describe("turn order", () => {
  it("cycles through players in order", () => {
    let story = openStory();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(nextPlayerId(story)!);
      story = submitTurn(story, nextPlayerId(story)!, "🐱", story.turns.length, NOW);
    }
    expect(order).toEqual(["ana", "ben", "cy", "ana"]);
  });
});

describe("submitTurn", () => {
  it("adds a scene from the player whose turn it is", () => {
    const story = submitTurn(openStory(), "ana", "🌙", 0, NOW);
    expect(story.turns).toEqual([{ playerId: "ana", scene: "🌙", index: 0 }]);
  });

  it("refuses a turn from a player who is not up", () => {
    expect(() => submitTurn(openStory(), "ben", "🌙", 0, NOW)).toThrow(/turn/i);
  });

  it("refuses a stale expected index, so two devices cannot both claim one turn", () => {
    const once = submitTurn(openStory(), "ana", "🌙", 0, NOW);
    // Another device still thinks turn 0 is open and tries to write it.
    expect(() => submitTurn(once, "ana", "🐱", 0, NOW)).toThrow(/already|stale|changed/i);
  });

  it("refuses turns from strangers who are not players", () => {
    expect(() => submitTurn(openStory(), "mallory", "🌙", 0, NOW)).toThrow(/player/i);
  });

  it("refuses non-emoji scenes", () => {
    expect(() => submitTurn(openStory(), "ana", "hi", 0, NOW)).toThrow(/emoji/i);
  });

  it("finishes automatically at MAX_TURNS and refuses further turns", () => {
    let story = openStory();
    for (let i = 0; i < MAX_TURNS; i++) {
      story = submitTurn(story, nextPlayerId(story)!, "🐱", story.turns.length, NOW);
    }
    expect(story.status).toBe("finished");
    expect(() => submitTurn(story, "ana", "🐱", MAX_TURNS, NOW)).toThrow(/finished/i);
  });

  it("keeps the serialized story within the 4 KiB limit", () => {
    let story = openStory();
    for (let i = 0; i < MAX_TURNS; i++) {
      story = submitTurn(story, nextPlayerId(story)!, "🐱".repeat(MAX_SCENE_GRAPHEMES), story.turns.length, NOW);
    }
    expect(storyBytes(story)).toBeLessThanOrEqual(MAX_STORY_BYTES);
  });
});

describe("finishStory", () => {
  it("lets only the host submit the finished story early, after at least one turn", () => {
    const once = submitTurn(openStory(), "ana", "🌙", 0, NOW);
    expect(() => finishStory(once, "ben", NOW)).toThrow(/host/i);
    expect(finishStory(once, "ana", NOW).status).toBe("finished");
  });

  it("refuses to finish an empty story", () => {
    expect(() => finishStory(openStory(), "ana", NOW)).toThrow(/at least one turn/i);
  });
});
