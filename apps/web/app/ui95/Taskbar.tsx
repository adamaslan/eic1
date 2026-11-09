import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { BUILD_DATE, BUILD_SHA } from "~/build-info";
import { playBlip } from "~/platform/sounds";
import { useThemeStore } from "~/platform/theme-store";
import { Bevel } from "./Bevel";
import { Button95 } from "./Button95";
import { StartMenu, type StartItem } from "./StartMenu";

interface TaskbarProps {
  startLabel?: string;
  onStart?: () => void;
  clock: string;
  children?: ReactNode;
  /** Shortcuts for the pop-up Start menu. Without them, no Start button is shown. */
  startItems?: StartItem[];
}

// Bottom bar: Start menu, the primary action button (Lock), optional task items, a tray
// with the Display Properties shortcut, build stamp, and a sunken clock.
// Sticky, not fixed: it stays pinned to the viewport bottom while scrolling, but it
// also occupies flow space at the document end, so page content can never be trapped
// beneath it (a fixed bar overlaps the bottom of slightly-taller-than-viewport pages
// with no way to scroll clear).
export function Taskbar({ startLabel = "Start", onStart, clock, children, startItems }: TaskbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDate, setShowDate] = useState(false);
  const setDisplayOpen = useThemeStore((s) => s.setDisplayOpen);
  return (
    <footer
      className="sticky inset-x-0 bottom-0 z-10 flex items-center gap-1 bg-[var(--w95-face)] p-1"
      style={{ borderTop: "1px solid var(--w95-light)", boxShadow: "0 -1px 0 var(--w95-hilite)" }}
    >
      {startItems && (
        <div className="relative">
          <StartMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={startItems} />
          <button
            type="button"
            data-start-button
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="start-menu"
            onClick={() => {
              playBlip(menuOpen ? "close" : "open");
              setMenuOpen((open) => !open);
            }}
            className="min-h-[44px] cursor-pointer bg-[var(--w95-face)] sm:min-h-0"
          >
            <Bevel variant={menuOpen ? "in" : "out"}>
              <span className={`flex items-center gap-1 px-2 py-1 text-[12px] font-bold text-[var(--w95-ink)] ${menuOpen ? "translate-x-px translate-y-px" : ""}`}>
                <motion.span
                  aria-hidden="true"
                  className="inline-grid h-[14px] w-[14px] grid-cols-2 gap-px"
                  animate={menuOpen ? { rotate: 90 } : { rotate: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <span className="bg-[#ff3b30]" />
                  <span className="bg-[#34c759]" />
                  <span className="bg-[#0a84ff]" />
                  <span className="bg-[#ffcc00]" />
                </motion.span>
                Start
              </span>
            </Bevel>
          </button>
        </div>
      )}
      <Button95 onClick={onStart} className="font-bold">
        {startLabel}
      </Button95>
      <div className="flex min-w-0 flex-1 gap-1">{children}</div>
      <Bevel variant="in">
        <span className="flex items-center gap-1 px-1 py-0.5 text-[11px] tabular-nums text-[var(--w95-ink)]">
          {startItems && (
            <button
              type="button"
              aria-label="Display Properties"
              title="Display Properties"
              onClick={() => {
                playBlip("open");
                setDisplayOpen(true);
              }}
              className="min-h-[36px] min-w-[28px] cursor-pointer text-[14px] sm:min-h-0"
            >
              🎨
            </button>
          )}
          <span className="hidden px-1 sm:inline" title={`Built ${BUILD_DATE}`}>
            build {BUILD_SHA}
          </span>
          <button
            type="button"
            className="cursor-pointer px-1"
            title="Show the date"
            onClick={() => setShowDate((d) => !d)}
          >
            {showDate ? new Date().toLocaleDateString([], { month: "short", day: "numeric" }) : clock}
          </button>
        </span>
      </Bevel>
    </footer>
  );
}
