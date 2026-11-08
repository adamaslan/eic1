import { useEffect, useRef, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { fontPacks } from "@veil/tokens";
import { resolveColors, useThemeStore } from "~/platform/theme-store";

const VARS: Record<string, keyof ReturnType<typeof resolveColors>> = {
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
};

// Applies Display Properties to the document after hydration. The prerendered shell
// carries the classic defaults from app.css, so nothing here changes server/client markup.
export function ThemeRoot({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const loaded = useThemeStore((s) => s.loaded);
  const load = useThemeStore((s) => s.load);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  useEffect(() => {
    const root = document.documentElement;
    const colors = resolveColors(theme);
    for (const [name, key] of Object.entries(VARS)) root.style.setProperty(name, colors[key]);
    root.style.setProperty("--w95-scale", String(theme.scale));
    root.style.setProperty("--w95-font", fontPacks[theme.font].stack);
    root.style.setProperty("--w95-radius", theme.soft ? "6px" : "0px");
    root.dataset.wall = theme.wallpaper;
    root.dataset.motion = theme.motion;
    if (theme.crt) root.dataset.crt = "";
    else delete root.dataset.crt;
    if (luminance(colors.ink) > luminance(colors.face)) root.dataset.dark = "";
    else delete root.dataset.dark;
    if (theme.soft) root.dataset.soft = "";
    else delete root.dataset.soft;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors.desk);
  }, [theme]);

  // "off" disables every spring; "calm"/"party" still honour the OS reduced-motion setting.
  return (
    <MotionConfig reducedMotion={theme.motion === "off" ? "always" : "user"}>
      {children}
      {theme.cursor !== "none" && theme.motion !== "off" && <CursorFx kind={theme.cursor} />}
    </MotionConfig>
  );
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
