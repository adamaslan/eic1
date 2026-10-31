import { useEffect } from "react";
import { SESSION_MS } from "./session-persist";

export const AUTO_LOCK_MS = SESSION_MS;
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

/** Locks when the session's hour is up, even if the user has been active the whole time. */
export function useSessionExpiry(expiresAt: number | null, onExpire: () => void): void {
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(onExpire, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, onExpire]);
}
