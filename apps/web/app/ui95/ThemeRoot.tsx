import { useEffect, useRef, useState, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";
import { fontPacks } from "@veil/tokens";
import { useThemeStore, type CursorPack, type ThemeSettings } from "~/platform/theme-store";
import { playBlip } from "~/platform/sounds";
import { colorsAt, decorativeMotionOff, nextThemeBoundary } from "~/platform/theme-behavior";

const VARS = {
  "--w95-face": "face",
  "--w95-shade": "shade",
  "--w95-hilite": "hilite",
  "--w95-light": "light",
  "--w95-ink": "ink",
  "--w95-desk": "desk",
  "--w95-title-a": "titleA",
  "--w95-title-b": "titleB",
  "--w95-title-text": "titleText",
  "--w95-accent": "accent",
  "--w95-link": "link",
} as const;

// Applies Display Properties to the document after hydration. The prerendered shell
// carries the classic defaults from app.css, so nothing here changes server/client markup.
export function ThemeRoot({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const osReduced = useReducedMotion();
  const still = decorativeMotionOff(theme.motion, osReduced === true);
  const [clockVersion, setClockVersion] = useState(0);
  const loaded = useThemeStore((s) => s.loaded);
  const load = useThemeStore((s) => s.load);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  useEffect(() => {
    const root = document.documentElement;
    const colors = colorsAt(theme, new Date());
    for (const [name, key] of Object.entries(VARS)) root.style.setProperty(name, colors[key]);
    root.style.setProperty("--w95-scale", String(theme.scale));
    root.style.setProperty("--w95-font", fontFor(theme));
    root.style.setProperty("--w95-radius", theme.soft ? "6px" : "0px");
    root.style.setProperty("--w95-cursor", cursorFor(theme.cursorPack));
    root.dataset.wall = theme.wallpaper;
    root.dataset.title = theme.titleStyle;
    root.dataset.motion = theme.motion;
    root.dataset.cursor = theme.cursorPack;
    setFlag(root, "crt", theme.crt);
    setFlag(root, "soft", theme.soft);
    setFlag(root, "dark", luminance(colors.ink) > luminance(colors.face));
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors.desk);
  }, [theme, clockVersion]);

  useEffect(() => {
    if (!theme.autoDay) return;
    let timer: number;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setClockVersion(v => v + 1);
        schedule();
      }, nextThemeBoundary(new Date()));
    };
    const resume = () => {
      if (document.visibilityState === "visible") {
        setClockVersion(v => v + 1);
        schedule();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [theme.autoDay]);

  // Easter egg: type "hotdog" anywhere on the desktop to unlock the hot-dog stand.
  useEffect(() => {
    let typed = "";
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key.length !== 1) return;
      typed = (typed + event.key.toLowerCase()).slice(-6);
      if (typed === "hotdog") {
        typed = "";
        useThemeStore.getState().choosePreset("hotdog");
        playBlip("tada");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "off" disables every spring; "calm"/"party" still honour the OS reduced-motion setting.
  return (
    <MotionConfig reducedMotion={theme.motion === "off" ? "always" : "user"}>
      {children}
      {theme.cursor !== "none" && !still && <CursorFx kind={theme.cursor} />}
      {theme.confetti && theme.motion === "party" && !still && <ConfettiFx />}
      {theme.bootSplash && !still && <BootSplash />}
      {theme.screensaver && <IdleSaver still={still} />}
    </MotionConfig>
  );
}

function setFlag(root: HTMLElement, name: string, on: boolean) {
  if (on) root.dataset[name] = "";
  else delete root.dataset[name];
}

function fontFor(theme: ThemeSettings): string {
  return fontPacks[theme.font].stack;
}

const CURSOR_SVG: Record<CursorPack, string> = {
  classic: "auto",
  hourglass: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ctext y='16' font-size='16'%3E%E2%8C%9B%3C/text%3E%3C/svg%3E") 8 8, wait`,
  sticker: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ctext y='16' font-size='16'%3E%E2%AD%90%3C/text%3E%3C/svg%3E") 4 4, pointer`,
};

function cursorFor(pack: CursorPack): string {
  return CURSOR_SVG[pack];
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SPARKLE_GLYPHS = ["✦", "✧", "★", "♥", "✿"];
const MAX_PARTICLES = 24;

// Pointer sparkles / trail, drawn as short-lived DOM nodes in a fixed layer. Throttled and
// capped so it never piles up; pointer-events none so it can't intercept a tap.
function CursorFx({ kind }: { kind: "sparkles" | "trail" }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = 0;
    const onMove = (event: PointerEvent) => {
      const el = layer.current;
      const now = performance.now();
      if (!el || now - last < (kind === "trail" ? 16 : 45)) return;
      last = now;
      if (el.childElementCount >= MAX_PARTICLES) el.firstElementChild?.remove();
      const dot = document.createElement("span");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--w95-accent") || "#b6f24e";
      dot.textContent = kind === "trail" ? "" : SPARKLE_GLYPHS[Math.floor(Math.random() * SPARKLE_GLYPHS.length)];
      Object.assign(dot.style, {
        position: "absolute",
        left: `${event.clientX}px`,
        top: `${event.clientY}px`,
        width: kind === "trail" ? "6px" : "auto",
        height: kind === "trail" ? "6px" : "auto",
        background: kind === "trail" ? accent : "transparent",
        color: accent,
        fontSize: "14px",
        textShadow: "1px 1px 0 #000",
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
      });
      el.appendChild(dot);
      const dx = (Math.random() - 0.5) * 30;
      const animation = dot.animate(
        [
          { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
          { opacity: 0, transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${kind === "trail" ? 0 : 24}px)) scale(0.3)` },
        ],
        { duration: kind === "trail" ? 400 : 700, easing: "ease-out" },
      );
      animation.onfinish = () => dot.remove();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [kind]);
  return <div ref={layer} aria-hidden="true" className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" />;
}

// Party-mode confetti from save/send/post buttons. Capped to 14 pieces per burst.
const CONFETTI_LABEL = /save|send|share|post|submit|add entry/i;
function ConfettiFx() {
  useEffect(() => {
    const pieces = new Set<HTMLElement>();
    const onClick = (event: MouseEvent) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const button = (event.target as HTMLElement).closest("button");
      if (!button || !CONFETTI_LABEL.test(button.textContent ?? "")) return;
      const colors = ["#ff3fa4", "#ffd166", "#00e5ff", "#b6f24e", "#ffffff"];
      for (let i = 0; i < 14; i++) {
        const piece = document.createElement("span");
        Object.assign(piece.style, {
          position: "fixed",
          left: `${event.clientX}px`,
          top: `${event.clientY}px`,
          width: "6px",
          height: "6px",
          background: colors[i % colors.length],
          pointerEvents: "none",
          zIndex: "75",
        });
        if (pieces.size >= 42) { const oldest = pieces.values().next().value; oldest?.remove(); if (oldest) pieces.delete(oldest); }
        pieces.add(piece);
        piece.dataset.confetti = "";
        document.body.appendChild(piece);
        const dx = (Math.random() - 0.5) * 220;
        const dy = -60 - Math.random() * 120;
        const animation = piece.animate(
          [
            { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
            { transform: `translate(${dx}px, ${dy + 220}px) rotate(540deg)`, opacity: 0 },
          ],
          { duration: 900 + Math.random() * 400, easing: "cubic-bezier(.2,.7,.4,1)" },
        );
        animation.onfinish = () => { piece.remove(); pieces.delete(piece); };
      }
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      pieces.forEach(piece => { piece.getAnimations().forEach(a => a.cancel()); piece.remove(); });
    };
  }, []);
  return null;
}

// One-time boot splash per browser session. Skippable; never blocks a tap for more than 1.2s.
const BOOT_KEY = "eic.boot.shown.v1";
function BootSplash() {
  const [show, setShow] = useState(() => {
    try {
      return window.sessionStorage.getItem(BOOT_KEY) === null;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!show) return;
    try {
      window.sessionStorage.setItem(BOOT_KEY, "1");
    } catch {
      // Storage blocked: the splash simply shows again next load.
    }
    const timer = window.setTimeout(() => setShow(false), 1200);
    return () => window.clearTimeout(timer);
  }, [show]);
  if (!show) return null;
  return (
    <div role="status" aria-label="Starting Everybody is Cool" className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-[var(--w95-desk)] text-[var(--w95-title-text)]">
      <p className="text-[18px] font-bold">Starting Everybody is Cool…</p>
      <div className="h-3 w-56 overflow-hidden border border-[var(--w95-ink)] bg-[var(--w95-face)] p-px">
        <div className="h-full w-full origin-left bg-[var(--w95-title-a)] [animation:w95-boot_1.2s_linear_forwards]" />
      </div>
      <button type="button" onClick={() => setShow(false)} className="mt-2 cursor-pointer bg-[var(--w95-face)] px-3 py-1 text-[12px] text-[var(--w95-ink)]">
        Skip
      </button>
    </div>
  );
}

// Starfield after 5 idle minutes. Any input dismisses it. Shows no content, and is static
// under reduced motion.
const IDLE_MS = 5 * 60_000;
function IdleSaver({ still }: { still: boolean }) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const reset = () => {
      window.clearTimeout(timer);
      setIdle(false);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, reset);
    };
  }, []);
  if (!idle) return null;
  return <Starfield still={still} />;
}

function Starfield({ still }: { still: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() * 0.9 + 0.1 }));
    let frame = 0;
    const draw = () => {
      el.width = window.innerWidth;
      el.height = window.innerHeight;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, el.width, el.height);
      ctx.fillStyle = "#fff";
      for (const star of stars) {
        if (!still) star.z -= 0.004;
        if (star.z <= 0.05) star.z = 1;
        const x = (star.x - 0.5) / star.z * el.width * 0.5 + el.width / 2;
        const y = (star.y - 0.5) / star.z * el.height * 0.5 + el.height / 2;
        ctx.fillRect(x, y, 1.5 / star.z, 1.5 / star.z);
      }
      if (!still) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return (
    <div role="presentation" className="fixed inset-0 z-[85] cursor-pointer">
      <canvas ref={canvas} aria-hidden="true" className="h-full w-full" />
      <p className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-[12px] text-white/70">Tap or press a key to return</p>
    </div>
  );
}
