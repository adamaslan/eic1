/**
 * Sticker remix challenge: friends each arrange built-in stickers on a shared theme, then the
 * host reveals every layout. A layout is a manifest that names sticker kinds and positions. It
 * carries no image data, and the client renders it locally. Pure logic: no I/O, no network,
 * no vault record kinds.
 */

export const BUILT_IN_STICKERS = ["star", "heart", "flower", "smile"] as const;
export type BuiltInSticker = (typeof BUILT_IN_STICKERS)[number];

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLACEMENTS = 12;
export const MAX_THEME_CHARS = 40;
export const MAX_LAYOUT_BYTES = 2048;

export interface Placement {
  sticker: BuiltInSticker;
  /** Normalized canvas position, clamped to 0.05-0.95. */
  x: number;
  y: number;
  /** 0.5-3, like the profile sticker scale. */
  scale: number;
  /** Degrees, -180 to 180. */
  rotation: number;
}

export interface Layout {
  playerId: string;
  placements: Placement[];
  submittedAt: string;
}

export interface StickerChallenge {
  id: string;
  hostId: string;
  theme: string;
  players: string[];
  /** The host's chosen subset of built-in stickers that every participant may use. */
  allowedStickers: BuiltInSticker[];
  layouts: Record<string, Layout>;
  status: "collecting" | "revealed";
  createdAt: string;
  revealedAt?: string;
}

export interface CreateChallengeInput {
  id: string;
  hostId: string;
  players: string[];
  theme: string;
  allowedStickers: BuiltInSticker[];
  now: Date;
}

const encoder = new TextEncoder();

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function layoutBytes(layout: Pick<Layout, "playerId" | "placements" | "submittedAt">): number {
  return encoder.encode(JSON.stringify(layout)).length;
}

export function createChallenge(input: CreateChallengeInput): StickerChallenge {
  const { players } = input;
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`A challenge needs two to six players.`);
  }
  if (new Set(players).size !== players.length) throw new Error("Each player must be unique.");
  if (!players.includes(input.hostId)) throw new Error("The host must be one of the players.");
  const theme = input.theme.trim();
  if (!theme) throw new Error("A challenge needs a theme.");
  if (theme.length > MAX_THEME_CHARS) throw new Error(`The theme must be ${MAX_THEME_CHARS} characters or fewer.`);
  if (input.allowedStickers.length === 0) throw new Error("Allow at least one sticker.");
  for (const sticker of input.allowedStickers) {
    if (!BUILT_IN_STICKERS.includes(sticker)) throw new Error("Only built-in stickers can be used.");
  }
  return {
    id: input.id,
    hostId: input.hostId,
    theme,
    players: [...players],
    allowedStickers: [...new Set(input.allowedStickers)],
    layouts: {},
    status: "collecting",
    createdAt: input.now.toISOString(),
  };
}

function validatePlacement(placement: Placement, allowed: BuiltInSticker[]): Placement {
  if (!BUILT_IN_STICKERS.includes(placement.sticker)) throw new Error("Only built-in stickers can be used.");
  if (!allowed.includes(placement.sticker)) throw new Error(`The sticker "${placement.sticker}" is not allowed in this challenge.`);
  if (![placement.x, placement.y, placement.rotation].every(Number.isFinite)) {
    throw new Error("Sticker coordinates and rotation must be finite numbers.");
  }
  if (!Number.isFinite(placement.scale) || placement.scale < 0.5 || placement.scale > 3) {
    throw new Error("Sticker scale must be between 0.5 and 3.");
  }
  return {
    sticker: placement.sticker,
    x: round2(clamp(placement.x, 0.05, 0.95)),
    y: round2(clamp(placement.y, 0.05, 0.95)),
    scale: round2(placement.scale),
    rotation: round2(clamp(placement.rotation, -180, 180)),
  };
}

/** Adds or replaces one player's layout. Only players may submit, and only before reveal. */
export function submitLayout(challenge: StickerChallenge, playerId: string, placements: Placement[], now: Date): StickerChallenge {
  if (challenge.status === "revealed") throw new Error("This challenge is already revealed.");
  if (!challenge.players.includes(playerId)) throw new Error("Only a player can submit a layout.");
  if (placements.length === 0) throw new Error("A layout needs at least one sticker.");
  if (placements.length > MAX_PLACEMENTS) throw new Error(`A layout can have at most ${MAX_PLACEMENTS} stickers.`);
  const clean = placements.map((placement) => validatePlacement(placement, challenge.allowedStickers));
  const layout: Layout = { playerId, placements: clean, submittedAt: now.toISOString() };
  if (layoutBytes(layout) > MAX_LAYOUT_BYTES) throw new Error("This layout is too large to share.");
  return { ...challenge, layouts: { ...challenge.layouts, [playerId]: layout } };
}

export function revealChallenge(challenge: StickerChallenge, actorId: string, now: Date): StickerChallenge {
  if (actorId !== challenge.hostId) throw new Error("Only the host can reveal the challenge.");
  if (challenge.status === "revealed") throw new Error("This challenge is already revealed.");
  if (Object.keys(challenge.layouts).length === 0) throw new Error("Wait for at least one layout before revealing.");
  return { ...challenge, status: "revealed", revealedAt: now.toISOString() };
}

/** Every layout, in the order players joined. Hidden until the host reveals. */
export function revealedGallery(challenge: StickerChallenge): Layout[] {
  if (challenge.status !== "revealed") throw new Error("The gallery opens after the host reveals.");
  return challenge.players
    .filter((player) => Object.prototype.hasOwnProperty.call(challenge.layouts, player))
    .map((player) => challenge.layouts[player]);
}
