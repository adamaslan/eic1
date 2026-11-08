import { describe, expect, it } from "vitest";
import { color, contrastRatio, themePresets, wcagLevel } from "@veil/tokens";
import { DEFAULT_THEME, decodeThemeCode, encodeThemeCode, resolveColors, sanitizeTheme } from "./theme-store";

describe("theme settings", () => {
  it("defaults to the classic look, identical to the original tokens", () => {
    const colors = resolveColors(DEFAULT_THEME);
    expect(colors.face).toBe(color.face);
    expect(colors.desk).toBe(color.desk);
    expect(colors.titleA).toBe(color.navy);
  });

  it("round-trips a customised theme through a share code", () => {
    const theme = sanitizeTheme({ ...DEFAULT_THEME, preset: "vaporwave", custom: { desk: "#123456" }, motion: "party", crt: true });
    const decoded = decodeThemeCode(encodeThemeCode(theme));
    expect(decoded).toEqual(theme);
    expect(resolveColors(decoded!).desk).toBe("#123456");
    expect(resolveColors(decoded!).face).toBe(themePresets.vaporwave.colors.face);
  });

  it("drops hostile or malformed values instead of applying them", () => {
    const theme = sanitizeTheme({
      preset: "__proto__",
      custom: { face: "red;background:url(x)", desk: "#00ff00", evil: "#000000" },
      wallpaper: "javascript:alert(1)",
      motion: "warp",
      scale: 99,
      cursor: 5,
      crt: "yes",
    });
    expect(theme.preset).toBe("classic");
    expect(theme.custom).toEqual({ desk: "#00ff00" });
    expect(theme.wallpaper).toBe("solid");
    expect(theme.motion).toBe("calm");
    expect(theme.scale).toBe(1.4);
    expect(theme.cursor).toBe("none");
    expect(theme.crt).toBe(false);
  });

  it("rejects codes that are not theme codes", () => {
    expect(decodeThemeCode("hello")).toBeNull();
    expect(decodeThemeCode("EIC95:!!!not-base64")).toBeNull();
    expect(decodeThemeCode(`EIC95:${"A".repeat(5000)}`)).toBeNull();
  });

  it("keeps font packs to known ids, falling back to classic", () => {
    expect(sanitizeTheme({ font: "typewriter" }).font).toBe("typewriter");
    expect(sanitizeTheme({ font: "url(https://evil)" }).font).toBe("classic");
    expect(DEFAULT_THEME.font).toBe("classic");
  });

  it("computes WCAG contrast correctly", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(wcagLevel(contrastRatio("#000000", "#ffffff"))).toBe("AAA");
    expect(wcagLevel(contrastRatio("#c0c0c0", "#ffffff"))).toBe("fail");
  });

  it("high-contrast preset meets AAA for its main text pair", () => {
    const c = themePresets.highContrast.colors;
    expect(wcagLevel(contrastRatio(c.ink, c.face))).toBe("AAA");
    expect(wcagLevel(contrastRatio(c.titleText, c.titleA))).toBe("AAA");
  });

  it("allowlists title-bar and sound-voice choices", () => {
    expect(sanitizeTheme({ titleStyle: "stripes", soundScheme: "eightBit" })).toMatchObject({ titleStyle: "stripes", soundScheme: "eightBit" });
    expect(sanitizeTheme({ titleStyle: "<img>", soundScheme: "boom" })).toMatchObject({ titleStyle: "gradient", soundScheme: "classic" });
  });

  it("allowlists every picks-3 setting and defaults safely", () => {
    const bad = sanitizeTheme({ cursorPack: "<x>", transition: "spin", autoDay: "yes", oneHand: 1, screensaver: "on", bootSplash: 0, confetti: null, marquee: [], pet: {} });
    expect(bad).toMatchObject({ cursorPack: "classic", transition: "fade", autoDay: false, oneHand: false, screensaver: false, bootSplash: false, confetti: false, marquee: false, pet: false });
    const good = sanitizeTheme({ cursorPack: "sticker", transition: "slide", autoDay: true, oneHand: true, screensaver: true, bootSplash: true, confetti: true, marquee: true, pet: true });
    expect(good).toMatchObject({ cursorPack: "sticker", transition: "slide", autoDay: true, oneHand: true, screensaver: true, bootSplash: true, confetti: true, marquee: true, pet: true });
  });
});
