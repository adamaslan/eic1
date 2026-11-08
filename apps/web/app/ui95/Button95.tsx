import type { ButtonHTMLAttributes, MouseEvent } from "react";
import { motion } from "motion/react";
import { playBlip } from "~/platform/sounds";
import { useThemeStore } from "~/platform/theme-store";
import { Bevel } from "./Bevel";

// motion.button redefines the drag/animation handlers; nobody passes the DOM ones here.
type NativeProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration" | "onDrag" | "onDragStart" | "onDragEnd"
>;

interface Button95Props extends NativeProps {
  pressed?: boolean;
  sunken?: boolean;
}

// Pressed state sinks the bevel and nudges content 1px, as Win95 did. On top of that,
// "calm" motion adds a tiny tap squish and "party" adds a springy hover wobble.
// Touch target is padded to 44px tall on small screens.
export function Button95({ pressed, sunken = pressed ?? false, className = "", children, onClick, ...rest }: Button95Props) {
  const motionLevel = useThemeStore((s) => s.theme.motion);
  const party = motionLevel === "party";
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    playBlip("click");
    onClick?.(event);
  };
  return (
    <motion.button
      type="button"
      aria-pressed={pressed}
      className={`w95-btn min-h-[44px] cursor-pointer bg-[var(--w95-face)] disabled:cursor-not-allowed sm:min-h-0 ${className}`}
      whileTap={rest.disabled || motionLevel === "off" ? undefined : { scale: party ? 0.9 : 0.97 }}
      whileHover={party && !rest.disabled ? { rotate: [0, -2, 2, 0], y: -1 } : undefined}
      transition={{ type: "spring", stiffness: 500, damping: 18 }}
      onClick={handleClick}
      {...rest}
    >
      <Bevel variant={sunken ? "in" : "out"}>
        <span
          className={`block px-3 py-1 text-[12px] text-[var(--w95-ink)] ${sunken ? "translate-x-px translate-y-px" : ""}`}
        >
          {children}
        </span>
      </Bevel>
    </motion.button>
  );
}
