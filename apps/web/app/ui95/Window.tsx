import { useId, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useThemeStore } from "~/platform/theme-store";
import { playBlip } from "~/platform/sounds";
import { Bevel } from "./Bevel";

interface WindowProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Small emoji or glyph shown before the title, like a Win95 window icon. */
  icon?: ReactNode;
  /** When given, a working close (×) button appears in the title bar. */
  onClose?: () => void;
}

function TitleButton({ label, onClick, children, "aria-controls": controls }: { label: string; onClick: () => void; children: ReactNode; "aria-controls"?: string }) {
  return (
    <button type="button" aria-label={label} aria-controls={controls} title={label} onClick={onClick} className="ml-0.5 cursor-pointer bg-[var(--w95-face)] leading-none">
      <Bevel variant="out">
        <span className="flex h-[12px] w-[14px] items-center justify-center text-[10px] font-bold text-[var(--w95-ink)]">{children}</span>
      </Bevel>
    </button>
  );
}

export function Window({ title, children, className, icon, onClose }: WindowProps) {
  const [minimized, setMinimized] = useState(false);
  const party = useThemeStore((s) => s.theme.motion === "party");
  const bodyId = useId();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={party ? { type: "spring", stiffness: 380, damping: 14 } : { duration: 0.16, ease: "easeOut" }}
    >
      <Bevel variant="out">
        <div className="bg-[var(--w95-face)] p-0.5 text-[12px] text-[var(--w95-ink)]" style={{ fontFamily: "Tahoma, 'MS Sans Serif', Verdana, sans-serif" }}>
          <div
            className={`flex h-[20px] items-center gap-1 px-1.5 text-[12px] font-bold text-[var(--w95-title-text)] ${party ? "w95-shimmer" : ""}`}
            style={{ background: "linear-gradient(90deg, var(--w95-title-a) 0%, var(--w95-title-b) 50%, var(--w95-title-a) 100%)", backgroundSize: "200% 100%" }}
            onDoubleClick={() => setMinimized((m) => !m)}
          >
            {icon && <span aria-hidden="true" className="shrink-0">{icon}</span>}
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <TitleButton
              aria-controls={bodyId}
              label={minimized ? "Restore window" : "Minimize window"}
              onClick={() => {
                playBlip(minimized ? "open" : "close");
                setMinimized((m) => !m);
              }}
            >
              {minimized ? "□" : "_"}
            </TitleButton>
            {onClose && (
              <TitleButton
                label="Close window"
                onClick={() => {
                  playBlip("close");
                  onClose();
                }}
              >
                ×
              </TitleButton>
            )}
          </div>
          <motion.div
            id={bodyId}
            inert={minimized}
            aria-hidden={minimized}
            initial={false}
            animate={minimized ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }}
            style={{ overflow: minimized ? "hidden" : "visible" }}
            transition={{ duration: 0.18 }}
          >
            <div className="p-2">{children}</div>
          </motion.div>
        </div>
      </Bevel>
    </motion.div>
  );
}
