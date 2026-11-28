import { PROFILE_AVATARS } from "@veil/features";

// Sticker fortune (proposal feature 4): a daily on-device sticker plus a tiny drawing prompt.
// Date-seeded from the local calendar day only. Nothing is stored, so there is no identifier,
// no streak to track and nothing to clear.

export const PROMPTS = [
  "Draw your desk from above.",
  "Draw the sound of a rainy window.",
  "Draw a tiny creature that lives in your keyboard.",
  "Draw a door that opens onto somewhere kind.",
  "Draw your favourite mug with a face.",
  "Draw one thing that made today a little better.",
  "Draw a cassette that plays only good news.",
  "Draw a map of a room you love.",
  "Draw a plant that grows from a song.",
  "Draw a friend you have not talked to in a while.",
] as const;

export interface Fortune {
  day: string;
  avatarId: string;
  avatarLabel: string;
  prompt: string;
}

export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function seed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function fortuneFor(date: Date): Fortune {
  const day = localDay(date);
  const base = seed(day);
  const avatar = PROFILE_AVATARS[base % PROFILE_AVATARS.length];
  return { day, avatarId: avatar.id, avatarLabel: avatar.label, prompt: PROMPTS[(base >>> 8) % PROMPTS.length] };
}
