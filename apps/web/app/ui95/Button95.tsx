import type { ButtonHTMLAttributes } from "react";
import { Bevel } from "./Bevel";

interface Button95Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  sunken?: boolean;
}

// Pressed state sinks the bevel and nudges content 1px, as Win95 did.
// Touch target is padded to 44px tall on small screens.
export function Button95({ pressed, sunken = pressed ?? false, className = "", children, ...rest }: Button95Props) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`min-h-[44px] cursor-pointer bg-[#c0c0c0] sm:min-h-0 ${className}`}
      {...rest}
    >
      <Bevel variant={sunken ? "in" : "out"}>
        <span
          className={`block px-3 py-1 text-[12px] text-[#0a0a0a] ${sunken ? "translate-x-px translate-y-px" : ""}`}
        >
          {children}
        </span>
      </Bevel>
    </button>
  );
}
