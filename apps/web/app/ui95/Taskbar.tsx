import type { ReactNode } from "react";
import { BUILD_DATE, BUILD_SHA } from "~/build-info";
import { Bevel } from "./Bevel";
import { Button95 } from "./Button95";

interface TaskbarProps {
  startLabel?: string;
  onStart?: () => void;
  clock: string;
  children?: ReactNode;
}

// Bottom bar: Start button, optional task items, build stamp, and a sunken clock.
// Sticky, not fixed: it stays pinned to the viewport bottom while scrolling, but it
// also occupies flow space at the document end, so page content can never be trapped
// beneath it (a fixed bar overlaps the bottom of slightly-taller-than-viewport pages
// with no way to scroll clear).
export function Taskbar({ startLabel = "Start", onStart, clock, children }: TaskbarProps) {
  return (
    <footer className="sticky inset-x-0 bottom-0 z-10 flex items-center gap-1 bg-[#c0c0c0] p-1">
      <Button95 onClick={onStart} className="font-bold">
        {startLabel}
      </Button95>
      <div className="flex min-w-0 flex-1 gap-1">{children}</div>
      <Bevel variant="in">
        <span className="block px-2 py-1 text-[11px] tabular-nums text-[#0a0a0a]" title={`Built ${BUILD_DATE}`}>
          build {BUILD_SHA}
        </span>
      </Bevel>
      <Bevel variant="in">
        <span className="block px-2 py-1 text-[11px] tabular-nums text-[#0a0a0a]">{clock}</span>
      </Bevel>
    </footer>
  );
}
