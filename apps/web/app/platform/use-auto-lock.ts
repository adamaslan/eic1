import { useEffect } from "react";
import { MAX_TIMER_MS, recordSessionActivity, sessionIdleRemaining, type SessionTiming } from "./session-policy";

export const AUTO_LOCK_MS = 60 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Input never revives an expired idle window; timestamps survive reload and suspended timers. */
export function useAutoLock(active: boolean, onIdle: () => void, timing: SessionTiming | null = null): void {
  useEffect(() => {
    if (!active) return;
    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const remaining = () => timing ? sessionIdleRemaining(timing, Date.now) : AUTO_LOCK_MS - (Date.now() - lastActivity);
    const check = () => {
      clearTimeout(timer);
      const left = remaining();
      if (left <= 0) onIdle();
      else timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
    };
    const restart = () => {
      if (remaining() <= 0 || (timing && !recordSessionActivity(timing, Date.now))) { onIdle(); return; }
      lastActivity = Date.now();
      check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, restart, { passive: true });
    check();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, restart);
    };
  }, [active, onIdle, timing]);
}

/** Chunk long deadlines: thirty days exceeds the browser's signed32-bit timer range. */
export function useSessionExpiry(expiresAt: number | null, onExpire: () => void): void {
  useEffect(() => {
    if (expiresAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      clearTimeout(timer);
      const left = expiresAt - Date.now();
      if (left <= 0) onExpire();
      else timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
    };
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
