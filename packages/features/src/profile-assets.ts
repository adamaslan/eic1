import { AppError } from "@veil/core";
import { PROFILE_MAX_DECORATIONS, ProfileSchema, type Decoration, type Profile } from "./profile";

export const PROFILE_STICKERS = ["star", "heart", "flower", "smile"] as const;
export type ProfileSticker = (typeof PROFILE_STICKERS)[number];
const shapes: Record<ProfileSticker, string> = {
  star: '<path fill="#ffff00" stroke="#000080" stroke-width="2" d="m18 2 4 10 12 1-9 8 3 12-10-6-10 6 3-12-9-8 12-1z"/>',
  heart: '<path fill="#ff80c0" stroke="#800080" stroke-width="2" d="M18 32 4 18C-4 4 12-2 18 9 24-2 40 4 32 18Z"/>',
  flower: '<g fill="#ff80ff" stroke="#800080"><circle cx="18" cy="9" r="7"/><circle cx="27" cy="18" r="7"/><circle cx="18" cy="27" r="7"/><circle cx="9" cy="18" r="7"/></g><circle cx="18" cy="18" r="6" fill="#ffff00"/>',
  smile: '<circle cx="18" cy="18" r="16" fill="#ffff00" stroke="#000080" stroke-width="2"/><circle cx="12" cy="13" r="2"/><circle cx="24" cy="13" r="2"/><path d="M9 22Q18 32 27 22" fill="none" stroke="#000080" stroke-width="2"/>',
};

export function addProfileSticker(profile: Profile, kind: ProfileSticker, id: string): Profile {
  if (!id || profile.decorations.some(d => d.id === id)) throw new AppError("Choose a unique decoration ID.");
  if (!PROFILE_STICKERS.includes(kind)) throw new AppError("Choose a built-in sticker.");
  if (profile.decorations.length >= PROFILE_MAX_DECORATIONS) throw new AppError("This profile already has 32 decorations. Remove one first.");
  const z = Math.max(0, ...profile.decorations.map(d => d.position.z)) + 1;
  return ProfileSchema.parse({ ...profile, decorations: [...profile.decorations, { id, kind, asset: { kind: "inline-svg", data: `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">${shapes[kind]}</svg>` }, position: { x: 0.1, y: 0.06, z }, scale: 1, rotation: 0 }] });
}

export function changeProfileSticker(profile: Profile, id: string, action: "left" | "right" | "up" | "down" | "grow" | "shrink" | "front" | "back" | "remove"): Profile {
  if (!profile.decorations.some(d => d.id === id)) throw new AppError("Select a decoration first.");
  if (action === "remove") return { ...profile, decorations: profile.decorations.filter(d => d.id !== id) };
  // Normalize z to a small ordered range, preserving the stable order of equal-z legacy decorations.
  let ordered = [...profile.decorations].sort((a, b) => a.position.z - b.position.z);
  if (action === "front" || action === "back") {
    const selected = ordered.find(d => d.id === id)!;
    ordered = ordered.filter(d => d.id !== id);
    if (action === "front") ordered.push(selected); else ordered.unshift(selected);
  }
  const clamp = (n: number) => Math.round(Math.max(0.05, Math.min(0.95, n)) * 100) / 100;
  const decorations: Decoration[] = ordered.map((d, i) => {
    const next = { ...d, position: { ...d.position, z: i } };
    if (d.id !== id) return next;
    if (action === "left") next.position.x = clamp(d.position.x - 0.05);
    if (action === "right") next.position.x = clamp(d.position.x + 0.05);
    if (action === "up") next.position.y = clamp(d.position.y - 0.05);
    if (action === "down") next.position.y = clamp(d.position.y + 0.05);
    if (action === "grow") next.scale = Math.min(3, Math.round((d.scale + 0.25) * 100) / 100);
    if (action === "shrink") next.scale = Math.max(0.5, Math.round((d.scale - 0.25) * 100) / 100);
    return next;
  });
  return ProfileSchema.parse({ ...profile, decorations });
}
