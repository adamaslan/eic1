import { useEffect } from "react";

export const AUTO_LOCK_MS = 5 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Calls `onIdle` once after AUTO_LOCK_MS with no input. Any input restarts the timer. */
export function useAutoLock(active: boolean, onIdle: () => void): void {
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(onIdle, AUTO_LOCK_MS);
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, AUTO_LOCK_MS);
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, restart, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, restart);
    };
  }, [active, onIdle]);
}
