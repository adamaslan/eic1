import { create } from "zustand";
import {
  fontPacks,
  themeColorKeys,
  themePresets,
  wallpapers,
  type ThemeColors,
  type FontPackId,
  type ThemePresetId,
  type WallpaperId,
} from "@veil/tokens";

// Display Properties: how this device's desktop looks. It is a per-device convenience,
// kept in localStorage and never written to the vault or sent anywhere. A theme holds
// colours and toggles only - no names, handles, content or keys - so a shared theme code
// reveals nothing about the person who made it.

export type TitleStyle = "gradient" | "flat" | "stripes";
export type SoundScheme = "classic" | "eightBit" | "silent";
const TITLE_STYLES: readonly TitleStyle[] = ["gradient", "flat", "stripes"];
const SOUND_SCHEMES: readonly SoundScheme[] = ["classic", "eightBit", "silent"];

export type CursorPack = "classic" | "hourglass" | "sticker";
export type TransitionStyle = "fade" | "slide" | "none";
const CURSOR_PACKS: readonly CursorPack[] = ["classic", "hourglass", "sticker"];
const TRANSITIONS: readonly TransitionStyle[] = ["fade", "slide", "none"];

export type MotionLevel = "off" | "calm" | "party";
export type CursorEffect = "none" | "sparkles" | "trail";

export interface ThemeSettings {
  preset: ThemePresetId;
  /** Per-colour overrides on top of the preset; absent keys follow the preset. */
  custom: Partial<ThemeColors>;
  wallpaper: WallpaperId;
  motion: MotionLevel;
  /** Text scale, 0.9 - 1.4. */
  scale: number;
  cursor: CursorEffect;
  crt: boolean;
  sounds: boolean;
  /** Title-bar look. */
  titleStyle: TitleStyle;
  /** Day/night: Midnight after 19:00 and before 07:00 on this device's clock, when no preset is pinned. */
  autoDay: boolean;
  cursorPack: CursorPack;
  /** Page-change animation. */
  transition: TransitionStyle;
  /** Puts the tab row and taskbar at the bottom for one-hand use on phones. */
  oneHand: boolean;
  /** Starfield after 5 idle minutes; never shows content. */
  screensaver: boolean;
  /** One-time 1.2s splash per browser session. */
  bootSplash: boolean;
  /** Confetti from save and send buttons in Party mode. */
  confetti: boolean;
  /** Scrolling tip in the taskbar. */
  marquee: boolean;
  /** Small desk pet in the tray. */
  pet: boolean;
  /** Click-sound voice. "silent" keeps the sound switch but plays nothing. */
  soundScheme: SoundScheme;
  /** Typeface pack for window text. */
  font: FontPackId;
  /** Rounded corners: a non-canonical but popular softening of the bevel. */
  soft: boolean;
}

export const STORAGE_KEY = "eic.display.v1";
const CODE_PREFIX = "EIC95:";
const MIN_SCALE = 0.9;
const MAX_SCALE = 1.4;
const HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_THEME: ThemeSettings = {
  preset: "classic",
  custom: {},
  wallpaper: "solid",
  motion: "calm",
  scale: 1,
  cursor: "none",
  crt: false,
  sounds: false,
  soft: false,
  autoDay: false,
  cursorPack: "classic",
  transition: "fade",
  oneHand: false,
  screensaver: false,
  bootSplash: false,
  confetti: false,
  marquee: false,
  pet: false,
  font: "classic",
  titleStyle: "gradient",
  soundScheme: "classic",
};

const MOTION_LEVELS: readonly MotionLevel[] = ["off", "calm", "party"];
const CURSOR_EFFECTS: readonly CursorEffect[] = ["none", "sparkles", "trail"];

function isPreset(value: unknown): value is ThemePresetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(themePresets, value);
}

function isFont(value: unknown): value is FontPackId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(fontPacks, value);
}

function isWallpaper(value: unknown): value is WallpaperId {
  return typeof value === "string" && wallpapers.some((w) => w.id === value);
}

/**
 * Accepts untrusted input (localStorage, a pasted theme code) and returns a valid theme.
 * Unknown keys are dropped and every bad value falls back to its default, so a corrupt or
 * hostile code can only ever produce a different colour scheme - never markup or script.
 */
export function sanitizeTheme(input: unknown): ThemeSettings {
  if (!input || typeof input !== "object") return { ...DEFAULT_THEME, custom: {} };
  const raw = input as Record<string, unknown>;
  const custom: Partial<ThemeColors> = {};
  if (raw.custom && typeof raw.custom === "object") {
    const rawCustom = raw.custom as Record<string, unknown>;
    for (const key of themeColorKeys) {
      const value = rawCustom[key];
      if (typeof value === "string" && HEX.test(value)) custom[key] = value.toLowerCase();
    }
  }
  const scale = typeof raw.scale === "number" && Number.isFinite(raw.scale) ? raw.scale : DEFAULT_THEME.scale;
  return {
    preset: isPreset(raw.preset) ? raw.preset : DEFAULT_THEME.preset,
    custom,
    wallpaper: isWallpaper(raw.wallpaper) ? raw.wallpaper : DEFAULT_THEME.wallpaper,
    motion: MOTION_LEVELS.includes(raw.motion as MotionLevel) ? (raw.motion as MotionLevel) : DEFAULT_THEME.motion,
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100)),
    cursor: CURSOR_EFFECTS.includes(raw.cursor as CursorEffect) ? (raw.cursor as CursorEffect) : DEFAULT_THEME.cursor,
    crt: raw.crt === true,
    sounds: raw.sounds === true,
    soft: raw.soft === true,
    autoDay: raw.autoDay === true,
    cursorPack: CURSOR_PACKS.includes(raw.cursorPack as CursorPack) ? (raw.cursorPack as CursorPack) : DEFAULT_THEME.cursorPack,
    transition: TRANSITIONS.includes(raw.transition as TransitionStyle) ? (raw.transition as TransitionStyle) : DEFAULT_THEME.transition,
    oneHand: raw.oneHand === true,
    screensaver: raw.screensaver === true,
    bootSplash: raw.bootSplash === true,
    confetti: raw.confetti === true,
    marquee: raw.marquee === true,
    pet: raw.pet === true,
    font: isFont(raw.font) ? raw.font : DEFAULT_THEME.font,
    titleStyle: TITLE_STYLES.includes(raw.titleStyle as TitleStyle) ? (raw.titleStyle as TitleStyle) : DEFAULT_THEME.titleStyle,
    soundScheme: SOUND_SCHEMES.includes(raw.soundScheme as SoundScheme) ? (raw.soundScheme as SoundScheme) : DEFAULT_THEME.soundScheme,
  };
}

export function resolveColors(theme: ThemeSettings): ThemeColors {
  return { ...themePresets[theme.preset].colors, ...theme.custom };
}

/** A short text code friends can paste to copy each other's desktop look. */
export function encodeThemeCode(theme: ThemeSettings): string {
  const json = JSON.stringify(sanitizeTheme(theme));
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return CODE_PREFIX + btoa(binary);
}

/** Returns null for anything that is not a well-formed theme code. */
export function decodeThemeCode(code: string): ThemeSettings | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX) || trimmed.length > 4096) return null;
  try {
    const binary = atob(trimmed.slice(CODE_PREFIX.length));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return sanitizeTheme(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

function readStored(): ThemeSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeTheme(JSON.parse(raw)) : { ...DEFAULT_THEME, custom: {} };
  } catch {
    return { ...DEFAULT_THEME, custom: {} };
  }
}

function writeStored(theme: ThemeSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Private windows and blocked storage: the theme still applies for this visit.
  }
}

interface ThemeStore {
  theme: ThemeSettings;
  /** True once the stored theme has been read on the client. */
  loaded: boolean;
  displayOpen: boolean;
  load: () => void;
  set: (patch: Partial<ThemeSettings>) => void;
  setColor: (key: keyof ThemeColors, value: string) => void;
  choosePreset: (preset: ThemePresetId) => void;
  replace: (theme: ThemeSettings) => void;
  reset: () => void;
  setDisplayOpen: (open: boolean) => void;
}

export const useThemeStore = create<ThemeStore>((setState, getState) => {
  const commit = (theme: ThemeSettings) => {
    const clean = sanitizeTheme(theme);
    writeStored(clean);
    setState({ theme: clean });
  };
  return {
    theme: { ...DEFAULT_THEME, custom: {} },
    loaded: false,
    displayOpen: false,
    load: () => setState({ theme: readStored(), loaded: true }),
    set: (patch) => commit({ ...getState().theme, ...patch }),
    setColor: (key, value) => {
      const { theme } = getState();
      commit({ ...theme, custom: { ...theme.custom, [key]: value } });
    },
    choosePreset: (preset) =>
      commit({ ...getState().theme, preset, custom: {}, wallpaper: themePresets[preset].wallpaper }),
    replace: (theme) => commit(theme),
    reset: () => commit({ ...DEFAULT_THEME, custom: {} }),
    setDisplayOpen: (open) => setState({ displayOpen: open }),
  };
});
