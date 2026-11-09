import type { ReactNode } from "react";
import { Bevel } from "./Bevel";

// Raised panel used for feed cards and list rows. Wrap in a Link for navigation.
export function Card95({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <Bevel variant="out" className={`block bg-[var(--w95-face)] transition-transform duration-150 hover:-translate-y-px ${className}`}>
      <div className="p-1 text-[12px] text-[var(--w95-ink)]">{children}</div>
    </Bevel>
  );
}
