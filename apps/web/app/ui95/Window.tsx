import type { ReactNode } from "react";
import { color, font } from "@veil/tokens";
import { Bevel } from "./Bevel";

interface WindowProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function Window({ title, children, className }: WindowProps) {
  return (
    <Bevel variant="out" className={className}>
      <div className="p-0.5 text-[12px]" style={{ background: color.face, color: color.ink, fontFamily: font.ui.join(", ") }}>
        <div
          className="flex h-[20px] items-center px-1.5 text-[12px] font-bold text-white"
          style={{ background: `linear-gradient(90deg, ${color.navy} 0%, ${color.blue2} 100%)` }}
        >
          <span className="truncate">{title}</span>
        </div>
        <div className="p-2">{children}</div>
      </div>
    </Bevel>
  );
}
