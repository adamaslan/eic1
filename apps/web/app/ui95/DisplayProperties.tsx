import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  contrastRatio,
  fontPacks,
  themeColorKeys,
  themePresets,
  wallpapers,
  wcagLevel,
  type FontPackId,
  type ThemeColors,
  type ThemePresetId,
} from "@veil/tokens";
import {
  decodeThemeCode,
  encodeThemeCode,
  resolveColors,
  useThemeStore,
  type CursorEffect,
  type MotionLevel,
} from "~/platform/theme-store";
import { playBlip } from "~/platform/sounds";
import { Bevel } from "./Bevel";
import { Button95 } from "./Button95";
import { Tabs95 } from "./Tabs95";
import { Window } from "./Window";

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  face: "Window face",
  shade: "Shadow",
  hilite: "Highlight",
  light: "Edge light",
  ink: "Text",
  desk: "Desktop",
  titleA: "Title bar left",
  titleB: "Title bar right",
  titleText: "Title text",
  accent: "Accent",
  link: "Links",
};

const TABS = [
  { id: "themes", label: "Themes" },
  { id: "colors", label: "Colors" },
  { id: "desktop", label: "Desktop" },
  { id: "effects", label: "Effects" },
  { id: "share", label: "Share" },
];

const MOTION_OPTIONS: Array<{ id: MotionLevel; label: string }> = [
  { id: "off", label: "Still" },
  { id: "calm", label: "Calm" },
  { id: "party", label: "Party" },
];

const CURSOR_OPTIONS: Array<{ id: CursorEffect; label: string }> = [
  { id: "none", label: "Plain" },
  { id: "sparkles", label: "Sparkles" },
  { id: "trail", label: "Trail" },
];

// A tiny live desktop that previews a palette, like the monitor in the real Win95 dialog.
function MiniMonitor({ colors, wallpaper }: { colors: ThemeColors; wallpaper: string }) {
  return (
    <div className="mx-auto w-[150px]" aria-hidden="true">
      <Bevel variant="in">
        <div className={`h-[90px] p-2 w95-wall-${wallpaper}`} style={{ backgroundColor: colors.desk }}>
          <div style={{ background: colors.face, border: `1px solid ${colors.ink}` }}>
            <div className="h-[8px]" style={{ background: `linear-gradient(90deg, ${colors.titleA}, ${colors.titleB})` }} />
            <div className="flex gap-1 p-1">
              <div className="h-[10px] w-[24px]" style={{ background: colors.face, borderTop: `1px solid ${colors.light}`, borderLeft: `1px solid ${colors.light}`, borderRight: `1px solid ${colors.ink}`, borderBottom: `1px solid ${colors.ink}` }} />
              <div className="h-[10px] w-[10px] rounded-full" style={{ background: colors.accent }} />
            </div>
          </div>
        </div>
      </Bevel>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1">
      <legend className="mb-1 text-[12px]">{label}</legend>
      {options.map((option) => (
        <Button95 key={option.id} pressed={value === option.id} onClick={() => onChange(option.id)}>
          {option.label}
        </Button95>
      ))}
    </fieldset>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px]">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--w95-title-a)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-[var(--w95-shade)]">{hint}</span>}
      </span>
    </label>
  );
}

export function DisplayProperties() {
  const open = useThemeStore((s) => s.displayOpen);
  const setOpen = useThemeStore((s) => s.setDisplayOpen);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = dialog.current;
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      } else if (event.key === "Tab" && panel) {
        const items = [...panel.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']")]
          .filter((item) => item.getClientRects().length > 0);
        const first = items[0]; const last = items.at(-1);
        if (!first) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel || !panel.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLElement>("[data-start-button]")?.focus();
    };
  }, [open, setOpen]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="display"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-2 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <motion.div
            ref={dialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Display Properties"
            className="max-h-[90dvh] w-full max-w-[460px] overflow-y-auto"
            initial={{ y: 40, scale: 0.95 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 40, scale: 0.95, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <DisplayPanel onClose={() => setOpen(false)} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DisplayPanel({ onClose }: { onClose: () => void }) {
  const theme = useThemeStore((s) => s.theme);
  const set = useThemeStore((s) => s.set);
  const setColor = useThemeStore((s) => s.setColor);
  const choosePreset = useThemeStore((s) => s.choosePreset);
  const replace = useThemeStore((s) => s.replace);
  const reset = useThemeStore((s) => s.reset);
  const [tab, setTab] = useState("themes");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const colors = resolveColors(theme);

  const surprise = () => {
    const ids = Object.keys(themePresets) as ThemePresetId[];
    const preset = ids[Math.floor(Math.random() * ids.length)];
    const wall = wallpapers[Math.floor(Math.random() * wallpapers.length)].id;
    const hue = Math.floor(Math.random() * 360);
    choosePreset(preset);
    set({ wallpaper: wall });
    setColor("desk", hslToHex(hue, 55, 40));
    setColor("titleB", hslToHex((hue + 150) % 360, 80, 55));
    playBlip("tada");
    setMessage(`Surprise! ${themePresets[preset].label} with a twist.`);
  };

  return (
    <Window title="Display Properties" icon="🖥️" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <MiniMonitor colors={colors} wallpaper={theme.wallpaper} />
        <Tabs95 tabs={TABS} activeId={tab} onChange={setTab} />

        {tab === "themes" && (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {(Object.keys(themePresets) as ThemePresetId[]).map((id) => {
              const preset = themePresets[id];
              return (
                <Button95 key={id} pressed={theme.preset === id} onClick={() => choosePreset(id)}>
                  <span className="flex items-center gap-1">
                    <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0" style={{ background: `linear-gradient(135deg, ${preset.colors.desk} 50%, ${preset.colors.titleA} 50%)`, border: "1px solid #000" }} />
                    {preset.label}
                  </span>
                </Button95>
              );
            })}
          </div>
        )}

        {tab === "colors" && (
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {themeColorKeys.map((key) => (
              <label key={key} className="flex items-center justify-between gap-2 text-[12px]">
                <span>
                  {COLOR_LABELS[key]}
                  {theme.custom[key] && <span className="text-[var(--w95-shade)]"> *</span>}
                </span>
                <input type="color" value={colors[key]} onChange={(e) => setColor(key, e.target.value)} className="h-7 w-12 cursor-pointer border border-[var(--w95-ink)] bg-[var(--w95-face)]" />
              </label>
            ))}
            <ContrastCheck label="Text on window face" fg={colors.ink} bg={colors.face} />
            <ContrastCheck label="Title text on title bar" fg={colors.titleText} bg={colors.titleA} />
            <ContrastCheck label="Links on window face" fg={colors.link} bg={colors.face} />
            <p className="col-span-full text-[11px] text-[var(--w95-shade)]">* changed from the {themePresets[theme.preset].label} preset. Picking a preset clears your changes.</p>
          </div>
        )}

        {tab === "desktop" && (
          <div className="flex flex-col gap-3">
            <fieldset>
              <legend className="mb-1 text-[12px]">Wallpaper</legend>
              <div className="grid grid-cols-4 gap-1">
                {wallpapers.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    aria-pressed={theme.wallpaper === w.id}
                    onClick={() => set({ wallpaper: w.id })}
                    className="cursor-pointer bg-[var(--w95-face)] text-[11px]"
                  >
                    <Bevel variant={theme.wallpaper === w.id ? "in" : "out"}>
                      <span className={`block h-8 w95-wall-${w.id}`} style={{ backgroundColor: colors.desk }} />
                      <span className="block truncate px-0.5">{w.label}</span>
                    </Bevel>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-wrap items-center gap-1">
              <legend className="mb-1 text-[12px]">Font</legend>
              {(Object.keys(fontPacks) as FontPackId[]).map((id) => (
                <Button95 key={id} pressed={theme.font === id} onClick={() => set({ font: id })}>
                  <span style={{ fontFamily: fontPacks[id].stack }}>{fontPacks[id].label}</span>
                </Button95>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-[12px]">
              Text size: {Math.round(theme.scale * 100)}%
              <input type="range" min={0.9} max={1.4} step={0.05} value={theme.scale} onChange={(e) => set({ scale: Number(e.target.value) })} />
            </label>
            <Segmented
              label="Title bars"
              value={theme.titleStyle}
              options={[
                { id: "gradient", label: "Gradient" },
                { id: "flat", label: "Flat" },
                { id: "stripes", label: "Stripes" },
              ]}
              onChange={(titleStyle) => set({ titleStyle })}
            />
            <Toggle label="Soft corners" hint="Rounds the bevels a little. Not period-accurate, very comfy." checked={theme.soft} onChange={(soft) => set({ soft })} />
          </div>
        )}

        {tab === "effects" && (
          <div className="flex flex-col gap-3">
            <Segmented label="Animation" value={theme.motion} options={MOTION_OPTIONS} onChange={(motion) => set({ motion })} />
            <p className="text-[11px] text-[var(--w95-shade)]">Your device's reduce-motion setting always wins over Calm and Party.</p>
            <Segmented label="Cursor" value={theme.cursor} options={CURSOR_OPTIONS} onChange={(cursor) => set({ cursor })} />
            <Toggle label="CRT scanlines" hint="Old-monitor glow over the whole desktop." checked={theme.crt} onChange={(crt) => set({ crt })} />
            <Segmented
              label="Sound voice"
              value={theme.soundScheme}
              options={[
                { id: "classic", label: "Classic" },
                { id: "eightBit", label: "8-bit" },
                { id: "silent", label: "Silent" },
              ]}
              onChange={(soundScheme) => set({ soundScheme })}
            />
            <Toggle label="Click sounds" hint="Tiny synthesized beeps. Off by default." checked={theme.sounds} onChange={(sounds) => set({ sounds })} />
          </div>
        )}

        {tab === "share" && (
          <div className="flex flex-col gap-2 text-[12px]">
            <p>Your theme code holds only colours and switches - nothing about you or your vault.</p>
            <Button95
              onClick={async () => {
                const next = encodeThemeCode(theme);
                setCode(next);
                try {
                  await navigator.clipboard.writeText(next);
                  setMessage("Theme code copied. Paste it to a friend!");
                } catch {
                  setMessage("Copy the code from the box below.");
                }
              }}
            >
              Copy my theme code
            </Button95>
            <label className="flex flex-col gap-1">
              Theme code
              <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} className="w-full resize-none border border-[var(--w95-ink)] bg-white p-1 font-mono text-[11px] text-black" placeholder="EIC95:..." />
            </label>
            <Button95
              onClick={() => {
                const decoded = decodeThemeCode(code);
                if (!decoded) {
                  setMessage("That doesn't look like a theme code.");
                  return;
                }
                replace(decoded);
                playBlip("tada");
                setMessage("Theme applied!");
              }}
            >
              Apply theme code
            </Button95>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-1 border-t border-[var(--w95-shade)] pt-2">
          <div className="flex gap-1">
            <Button95 onClick={surprise}>🎲 Surprise me</Button95>
            <Button95
              onClick={() => {
                reset();
                setMessage("Back to Windows Standard.");
              }}
            >
              Reset
            </Button95>
          </div>
          <Button95 onClick={onClose} className="font-bold">
            OK
          </Button95>
        </div>
        <p role="status" aria-live="polite" className="min-h-[16px] text-[11px]">
          {message}
        </p>
      </div>
    </Window>
  );
}

// Live WCAG check for one colour pair, so a custom palette can't quietly become unreadable.
function ContrastCheck({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  const ratio = contrastRatio(fg, bg);
  const level = wcagLevel(ratio);
  const verdict = level === "fail" ? "⚠️ fails" : level;
  return (
    <p className="col-span-full flex items-center justify-between gap-2 text-[11px]">
      <span className="flex items-center gap-1">
        <span aria-hidden="true" className="inline-block h-3 w-6 border border-[var(--w95-ink)]" style={{ background: bg, color: fg }}>
          <span className="block text-center text-[9px] leading-[10px]" style={{ color: fg }}>Aa</span>
        </span>
        {label}
      </span>
      <span className="tabular-nums" aria-label={`${label} contrast ${ratio.toFixed(1)} to 1, ${verdict}`}>
        {ratio.toFixed(1)}:1 {verdict}
      </span>
    </p>
  );
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
