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

/** Locks when the session's fixed deadline is reached, even if the user has been active the whole time. */
export function useSessionExpiry(expiresAt: number | null, onExpire: () => void): void {
  useEffect(() => {
    if (expiresAt === null) return;
    const check = () => { if (Date.now() >= expiresAt) onExpire(); };
    const timer = setTimeout(check, Math.max(0, expiresAt - Date.now()));
    // Phone timers can be suspended. Re-check the wall-clock deadline on return.
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [expiresAt, onExpire]);
}
