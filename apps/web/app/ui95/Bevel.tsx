import type { CSSProperties, ReactNode } from "react";
import type { BevelVariant } from "@veil/tokens";

interface BevelProps {
  variant?: BevelVariant;
  className?: string;
  children: ReactNode;
}

// The four edge colours come from the active Display Properties theme (CSS variables
// set by ThemeRoot); fallbacks are the classic palette from @veil/tokens.
const EDGES: Record<BevelVariant, { outerTL: string; outerBR: string; innerTL: string; innerBR: string }> = {
  out: {
    outerTL: "var(--w95-light, #ffffff)",
    outerBR: "var(--w95-ink, #0a0a0a)",
    innerTL: "var(--w95-hilite, #dfdfdf)",
    innerBR: "var(--w95-shade, #808080)",
  },
  in: {
    outerTL: "var(--w95-ink, #0a0a0a)",
    outerBR: "var(--w95-light, #ffffff)",
    innerTL: "var(--w95-shade, #808080)",
    innerBR: "var(--w95-hilite, #dfdfdf)",
  },
};

function frame(tl: string, br: string): CSSProperties {
  return {
    borderStyle: "solid",
    borderWidth: 1,
    borderTopColor: tl,
    borderLeftColor: tl,
    borderBottomColor: br,
    borderRightColor: br,
  };
}

// Two nested bordered boxes. Border-based (not box-shadow) so the same
// structure ports to React Native View styles.
export function Bevel({ variant = "out", className = "", children }: BevelProps) {
  const edges = EDGES[variant];
  return (
    <div className={`w95-bevel ${className}`} style={frame(edges.outerTL, edges.outerBR)}>
      <div style={frame(edges.innerTL, edges.innerBR)}>{children}</div>
    </div>
  );
}
