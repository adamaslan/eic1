import type { ReactNode } from "react";
import { Bevel } from "./Bevel";

// Raised panel used for feed cards and list rows. Wrap in a Link for navigation.
export function Card95({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <Bevel variant="out" className={`block bg-[#c0c0c0] ${className}`}>
      <div className="p-1 text-[12px] text-[#0a0a0a]">{children}</div>
    </Bevel>
  );
}
