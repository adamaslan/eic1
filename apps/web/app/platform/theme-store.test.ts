import { describe, expect, it } from "vitest";
import { color, themePresets } from "@veil/tokens";
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
});
