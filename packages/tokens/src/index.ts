// Platform-neutral design tokens. Web reads these via Tailwind classes in
// app/app.css; Expo will import this object directly.

export const color = {
  face: "#c0c0c0",
  shade: "#808080",
  ink: "#0a0a0a",
  hilite: "#dfdfdf",
  white: "#ffffff",
  navy: "#000080",
  blue2: "#1084d0",
  desk: "#008080",
  lime: "#b6f24e",
  link: "#0000cc",
} as const;

export const font = {
  ui: ["Tahoma", "MS Sans Serif", "Verdana", "sans-serif"],
  mono: ["Courier New", "monospace"],
} as const;

export const space = { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 } as const;

// A Win95 bevel is two nested 1px frames. "out" raises the surface, "in" sinks it.
export const bevel = {
  out: {
    outerTL: color.white,
    outerBR: color.ink,
    innerTL: color.hilite,
    innerBR: color.shade,
  },
  in: {
    outerTL: color.ink,
    outerBR: color.white,
    innerTL: color.shade,
    innerBR: color.hilite,
  },
} as const;

export type BevelVariant = keyof typeof bevel;

// ---------------------------------------------------------------------------
// Themes. The default "classic" preset reproduces `color` exactly, so a person who
// never opens Display Properties sees the same desktop as before. Every other preset
// only changes values, never structure: the bevel is still two nested 1px frames.

export interface ThemeColors {
  /** Raised surface (button / window face). */
  face: string;
  /** Lower-right inner bevel edge. */
  shade: string;
  /** Upper-left inner bevel edge. */
  hilite: string;
  /** Upper-left outer bevel edge. */
  light: string;
  /** Text and lower-right outer bevel edge. */
  ink: string;
  /** Desktop background behind every window. */
  desk: string;
  /** Title bar gradient, left to right. */
  titleA: string;
  titleB: string;
  titleText: string;
  /** Selection, highlights and the fun bits. */
  accent: string;
  link: string;
}

export const themeColorKeys = [
  "face",
  "shade",
  "hilite",
  "light",
  "ink",
  "desk",
  "titleA",
  "titleB",
  "titleText",
  "accent",
  "link",
] as const satisfies readonly (keyof ThemeColors)[];

export interface ThemePreset {
  label: string;
  colors: ThemeColors;
  /** Wallpaper that best suits this preset; a person can still pick any wallpaper. */
  wallpaper: WallpaperId;
}

export const wallpapers = [
  { id: "solid", label: "(None)" },
  { id: "tiles", label: "Tiles" },
  { id: "checker", label: "Checkers" },
  { id: "clouds", label: "Clouds" },
  { id: "stars", label: "Starfield" },
  { id: "hearts", label: "Hearts" },
  { id: "grid", label: "Synth grid" },
  { id: "confetti", label: "Confetti" },
] as const;

export type WallpaperId = (typeof wallpapers)[number]["id"];

const classic: ThemeColors = {
  face: color.face,
  shade: color.shade,
  hilite: color.hilite,
  light: color.white,
  ink: color.ink,
  desk: color.desk,
  titleA: color.navy,
  titleB: color.blue2,
  titleText: color.white,
  accent: color.lime,
  link: color.link,
};

export const themePresets = {
  classic: { label: "Windows Standard", colors: classic, wallpaper: "solid" },
  hotdog: {
    label: "Hot Dog Stand",
    wallpaper: "checker",
    colors: { ...classic, face: "#ffff00", shade: "#b8a000", hilite: "#ffff99", desk: "#ff0000", titleA: "#ff0000", titleB: "#ff6a00", accent: "#ff0000", link: "#000000" },
  },
  vaporwave: {
    label: "Vaporwave",
    wallpaper: "grid",
    colors: { ...classic, face: "#e8d5ff", shade: "#9b7fc4", hilite: "#f6edff", desk: "#2b1055", titleA: "#ff3fa4", titleB: "#00e5ff", accent: "#ff3fa4", link: "#6a00ff" },
  },
  bubblegum: {
    label: "Bubblegum",
    wallpaper: "hearts",
    colors: { ...classic, face: "#ffd6e8", shade: "#d98cb0", hilite: "#ffeef6", desk: "#ff8fc7", titleA: "#d6247f", titleB: "#ff9ad5", accent: "#ff2f92", link: "#a3005a" },
  },
  rainy: {
    label: "Rainy Day",
    wallpaper: "clouds",
    colors: { ...classic, face: "#b9c4cf", shade: "#6d7f91", hilite: "#dde4ea", desk: "#4a6378", titleA: "#2f4858", titleB: "#7c9cb5", accent: "#7cd1ff", link: "#1b4f8a" },
  },
  matrix: {
    label: "Terminal",
    wallpaper: "stars",
    colors: { face: "#101810", shade: "#0a3d0a", hilite: "#1f4d1f", light: "#3cff6a", ink: "#3cff6a", desk: "#000000", titleA: "#003300", titleB: "#00a83a", titleText: "#caffd8", accent: "#3cff6a", link: "#9dff7a" },
  },
  midnight: {
    label: "Midnight",
    wallpaper: "stars",
    colors: { face: "#2b2d42", shade: "#15161f", hilite: "#3d405b", light: "#6c6f93", ink: "#edf2f4", desk: "#0b0c1a", titleA: "#5a189a", titleB: "#e0aaff", titleText: "#ffffff", accent: "#ffd166", link: "#9bd1ff" },
  },
  desert: {
    label: "Desert",
    wallpaper: "tiles",
    colors: { ...classic, face: "#d5c4a1", shade: "#9c8357", hilite: "#ece0c4", desk: "#a8603c", titleA: "#7a3e1d", titleB: "#d9893f", accent: "#ffb347", link: "#7a2e00" },
  },
  lime: {
    label: "Lime Soda",
    wallpaper: "confetti",
    colors: { ...classic, face: "#e4f7c8", shade: "#8fb35a", hilite: "#f4fde6", desk: "#2f8f5b", titleA: "#1d6b3a", titleB: "#b6f24e", titleText: "#ffffff", accent: "#b6f24e", link: "#0a5a2a" },
  },
} as const satisfies Record<string, ThemePreset>;

export type ThemePresetId = keyof typeof themePresets;
