import { useEffect } from "react";

// Idle safety is independent of the remembered-unlock maximum.
export const AUTO_LOCK_MS = 60 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Calls `onIdle` once after AUTO_LOCK_MS with no input. Any input restarts the timer. */
export function useAutoLock(active: boolean, onIdle: () => void): void {
  useEffect(() => {
    if (!active) return;
    let lastActivity = Date.now();
    const check = () => { if (Date.now() - lastActivity >= AUTO_LOCK_MS) onIdle(); };
    let timer = setTimeout(check, AUTO_LOCK_MS);
    const restart = () => {
      if (Date.now() - lastActivity >= AUTO_LOCK_MS) { onIdle(); return; }
      lastActivity = Date.now();
      clearTimeout(timer);
      timer = setTimeout(check, AUTO_LOCK_MS);
    };
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, restart, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
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
