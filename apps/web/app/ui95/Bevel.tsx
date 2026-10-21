import type { CSSProperties, ReactNode } from "react";
import { bevel, type BevelVariant } from "@veil/tokens";

interface BevelProps {
  variant?: BevelVariant;
  className?: string;
  children: ReactNode;
}

// Two nested bordered boxes. Border-based (not box-shadow) so the same
// structure ports to React Native View styles.
export function Bevel({ variant = "out", className, children }: BevelProps) {
  const edges = bevel[variant];
  const outer: CSSProperties = {
    borderStyle: "solid",
    borderWidth: 1,
    borderTopColor: edges.outerTL,
    borderLeftColor: edges.outerTL,
    borderBottomColor: edges.outerBR,
    borderRightColor: edges.outerBR,
  };
  const inner: CSSProperties = {
    borderStyle: "solid",
    borderWidth: 1,
    borderTopColor: edges.innerTL,
    borderLeftColor: edges.innerTL,
    borderBottomColor: edges.innerBR,
    borderRightColor: edges.innerBR,
  };
  return (
    <div className={className} style={outer}>
      <div style={inner}>{children}</div>
    </div>
  );
}
