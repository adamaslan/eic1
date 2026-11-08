import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useThemeStore } from "~/platform/theme-store";
import { playBlip } from "~/platform/sounds";
import { Bevel } from "./Bevel";

export interface StartItem {
  to: string;
  label: string;
  icon: string;
}

interface StartMenuProps {
  open: boolean;
  onClose: () => void;
  items: StartItem[];
}

// The classic pop-up Start menu: a vertical brand stripe, app shortcuts, then system items.
// It is a supplement to the visible tab row (the main navigation landmark), never a
// replacement, so every destination stays one tap away without opening it.
export function StartMenu({ open, onClose, items }: StartMenuProps) {
  const setDisplayOpen = useThemeStore((s) => s.setDisplayOpen);
  const motionLevel = useThemeStore((s) => s.theme.motion);
  const set = useThemeStore((s) => s.set);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-start-button]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onClose]);

  const rowClass =
    "flex min-h-[40px] w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-[12px] text-[var(--w95-ink)] hover:bg-[var(--w95-title-a)] hover:text-[var(--w95-title-text)] focus:bg-[var(--w95-title-a)] focus:text-[var(--w95-title-text)] focus:outline-none sm:min-h-[28px]";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          id="start-menu"
          aria-label="Start menu"
          className="w95-start-sheet absolute bottom-full left-1 z-40 mb-1 w-[230px] max-w-[calc(100vw-8px)]"
          style={{ transformOrigin: "bottom left" }}
          initial={{ opacity: 0, y: 12, scaleY: 0.6 }}
          animate={{ opacity: 1, y: 0, scaleY: 1 }}
          exit={{ opacity: 0, y: 8, scaleY: 0.7 }}
          transition={{ type: "spring", stiffness: 520, damping: 32 }}
        >
          <Bevel variant="out" className="bg-[var(--w95-face)]">
            <div className="flex">
              <div
                aria-hidden="true"
                className="flex w-[26px] shrink-0 items-end justify-center pb-2"
                style={{ background: "linear-gradient(0deg, var(--w95-title-a), var(--w95-title-b))" }}
              >
                <span className="text-[13px] font-bold whitespace-nowrap text-[var(--w95-title-text)] [writing-mode:vertical-rl] rotate-180">
                  <span className="font-black">eic</span>95
                </span>
              </div>
              <ul className="min-w-0 flex-1 py-1">
                {items.map((item, index) => (
                  <motion.li
                    key={item.to}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: motionLevel === "off" ? 0 : index * 0.02 }}
                  >
                    <Link to={item.to} onClick={onClose} className={rowClass}>
                      <span aria-hidden="true" className="w-5 text-center text-[16px]">{item.icon}</span>
                      {item.label}
                    </Link>
                  </motion.li>
                ))}
                <li aria-hidden="true" className="mx-1 my-1 border-t border-b border-t-[var(--w95-shade)] border-b-[var(--w95-light)]" />
                <li>
                  <button
                    type="button"
                    className={rowClass}
                    onClick={() => {
                      onClose();
                      playBlip("open");
                      setDisplayOpen(true);
                    }}
                  >
                    <span aria-hidden="true" className="w-5 text-center text-[16px]">🎨</span>
                    Display Properties…
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={rowClass}
                    onClick={() => {
                      const next = motionLevel === "party" ? "calm" : "party";
                      set({ motion: next });
                      if (next === "party") playBlip("tada");
                    }}
                  >
                    <span aria-hidden="true" className="w-5 text-center text-[16px]">🎉</span>
                    {motionLevel === "party" ? "Calm down" : "Party mode"}
                  </button>
                </li>
              </ul>
            </div>
          </Bevel>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
