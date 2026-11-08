import { describe, expect, it } from "vitest";
import { themePresets } from "@veil/tokens";
import { DEFAULT_THEME } from "./theme-store";
import { colorsAt, decorativeMotionOff, isNight, nextThemeBoundary } from "./theme-behavior";
const at = (h: number, m = 0) => new Date(2026, 10, 8, h, m);
describe("live theme behavior", () => {
  it("honors both explicit Still and OS reduced motion", () => {
    expect(decorativeMotionOff("off", false)).toBe(true);
    expect(decorativeMotionOff("party", true)).toBe(true);
    expect(decorativeMotionOff("calm", true)).toBe(true);
    expect(decorativeMotionOff("party", false)).toBe(false);
  });
  it("switches at exactly 7 and 19", () => {
    expect([6, 7, 18, 19].map(h => isNight(at(h)))).toEqual([true, false, false, true]);
  });
  it("schedules the next boundary rather than waiting for another settings change", () => {
    expect(nextThemeBoundary(at(6, 59))).toBe(60_000);
    expect(nextThemeBoundary(at(18, 59))).toBe(60_000);
    expect(nextThemeBoundary(at(19))).toBe(12 * 60 * 60_000);
  });
  it("keeps custom overrides and restores the pinned preset in daytime", () => {
    const theme = { ...DEFAULT_THEME, autoDay: true, preset: "vaporwave" as const, custom: { accent: "#123456" } };
    expect(colorsAt(theme, at(20))).toEqual({ ...themePresets.midnight.colors, accent: "#123456" });
    expect(colorsAt(theme, at(8))).toEqual({ ...themePresets.vaporwave.colors, accent: "#123456" });
  });
  it("leaves manual themes alone at night", () => {
    expect(colorsAt(DEFAULT_THEME, at(22))).toEqual(themePresets.classic.colors);
  });
});
