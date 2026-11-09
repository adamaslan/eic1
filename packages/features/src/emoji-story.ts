/**
 * Emoji-only story relay: friends take turns adding one short emoji scene, then the story is
 * finished and revealed. Pure logic: no I/O, no network, no vault record kinds. The expected-index guard validates one supplied snapshot only. Persistence must
 * atomically compare and replace the stored version to prevent concurrent overwrites.
 */

export const MAX_PLAYERS = 6;
export const MAX_TURNS = 12;
export const MAX_SCENE_GRAPHEMES = 12;
export const MAX_STORY_BYTES = 4096;

export interface StoryTurn {
  index: number;
  playerId: string;
  scene: string;
}

export interface EmojiStory {
  id: string;
  hostId: string;
  players: string[];
  turns: StoryTurn[];
  status: "open" | "finished";
  createdAt: string;
  finishedAt?: string;
}

export interface CreateStoryInput {
  id: string;
  hostId: string;
  players: string[];
  now: Date;
}

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Only pictographic characters, skin-tone modifiers, variation selectors, ZWJ and spaces. */
const EMOJI_ONLY = /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|️|‍|\s)+$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Trims and checks a scene. Returns the cleaned scene or throws. */
export function validateScene(raw: string): string {
  const scene = raw.trim();
  if (!scene) throw new Error("A scene needs at least one emoji.");
  if (!EMOJI_ONLY.test(scene) || !HAS_PICTOGRAPH.test(scene)) {
    throw new Error("Scenes may only contain emoji.");
  }
  const graphemes = [...segmenter.segment(scene.replace(/\s+/g, ""))].length;
  if (graphemes > MAX_SCENE_GRAPHEMES) {
    throw new Error(`A scene can have at most ${MAX_SCENE_GRAPHEMES} emoji.`);
  }
  return scene;
}

export function storyBytes(story: EmojiStory): number {
  return encoder.encode(JSON.stringify(story)).length;
}

function assertStorySize(story: EmojiStory): void {
  if (storyBytes(story) > MAX_STORY_BYTES) throw new Error(`A story must fit in ${MAX_STORY_BYTES} bytes.`);
}

export function createStory(input: CreateStoryInput): EmojiStory {
  const players = input.players;
  if (players.length > MAX_PLAYERS) throw new Error(`A story can have at most ${MAX_PLAYERS} players.`);
  if (new Set(players).size !== players.length) throw new Error("Each player must be unique.");
  if (!players.includes(input.hostId)) throw new Error("The host must be one of the players.");
  const story: EmojiStory = {
    id: input.id,
    hostId: input.hostId,
    players: [...players],
    turns: [],
    status: "open",
    createdAt: input.now.toISOString(),
  };
  assertStorySize(story);
  return story;
}

/** Turns go round the players in order. Null once the story is finished. */
export function nextPlayerId(story: EmojiStory): string | null {
  if (story.status === "finished") return null;
  return story.players[story.turns.length % story.players.length];
}

/**
 * Adds one scene. `expectedIndex` must equal the number of turns already stored; if another
 * snapshot contains an earlier write, this call is refused. Cross-device atomicity
 * requires a storage compare-and-set; two calls with the same stale snapshot can both succeed.
 */
export function submitTurn(
  story: EmojiStory,
  playerId: string,
  rawScene: string,
  expectedIndex: number,
  now: Date,
): EmojiStory {
  if (story.status === "finished") throw new Error("This story is already finished.");
  if (!story.players.includes(playerId)) throw new Error("Only a player can add a turn.");
  if (expectedIndex !== story.turns.length) {
    throw new Error("This story changed on another device. Refresh and try again.");
  }
  if (nextPlayerId(story) !== playerId) throw new Error("It is not your turn yet.");
  const scene = validateScene(rawScene);
  const turns = [...story.turns, { index: story.turns.length, playerId, scene }];
  const next: EmojiStory = { ...story, turns };
  const result: EmojiStory = turns.length >= MAX_TURNS
    ? { ...next, status: "finished", finishedAt: now.toISOString() }
    : next;
  assertStorySize(result);
  return result;
}

/** The host ends the story early. Needs at least one turn so an empty story is never published. */
export function finishStory(story: EmojiStory, actorId: string, now: Date): EmojiStory {
  if (actorId !== story.hostId) throw new Error("Only the host can finish the story.");
  if (story.status === "finished") throw new Error("This story is already finished.");
  if (story.turns.length === 0) throw new Error("Add at least one turn before finishing.");
  const result: EmojiStory = { ...story, status: "finished", finishedAt: now.toISOString() };
  assertStorySize(result);
  return result;
}
