import { themePresets } from "@veil/tokens";
import { resolveColors, type ThemeSettings } from "./theme-store";

export function isNight(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 19 || hour < 7;
}

export function colorsAt(theme: ThemeSettings, date: Date) {
  return theme.autoDay && isNight(date)
    ? { ...themePresets.midnight.colors, ...theme.custom }
    : resolveColors(theme);
}

// Recheck at the next local 07:00 or 19:00 boundary, including across midnight/DST.
export function nextThemeBoundary(date: Date): number {
  const next = new Date(date);
  if (date.getHours() < 7) next.setHours(7, 0, 0, 0);
  else if (date.getHours() < 19) next.setHours(19, 0, 0, 0);
  else { next.setDate(next.getDate() + 1); next.setHours(7, 0, 0, 0); }
  return Math.max(1, next.getTime() - date.getTime());
}

export function decorativeMotionOff(motion: ThemeSettings["motion"], osReduced: boolean): boolean {
  return motion === "off" || osReduced;
}
