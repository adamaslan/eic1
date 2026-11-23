import { afterEach, beforeEach, expect, it, vi } from "vitest";
const cleanups = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", () => ({ useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } }));
import { useAutoLock, useSessionExpiry } from "./use-auto-lock";
import { MAX_TIMER_MS, PRIVATE_DEVICE_SESSION_MS, beginSessionActivity, newSessionTiming } from "./session-policy";
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal("window",new EventTarget()); vi.stubGlobal("document",new EventTarget());
  const data = new Map<string,string>();
  vi.stubGlobal("localStorage",{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)});
});
afterEach(() => { for (const f of cleanups.splice(0)) f(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("chunks thirty-day expiry without signed32-bit overflow and expires at the fixed deadline", () => {
  const expire = vi.fn(); useSessionExpiry(Date.now()+PRIVATE_DEVICE_SESSION_MS,expire);
  vi.advanceTimersByTime(MAX_TIMER_MS); expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PRIVATE_DEVICE_SESSION_MS-MAX_TIMER_MS-1); expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(expire).toHaveBeenCalledOnce();
});
it("uses the selected idle window but the default remains one hour", () => {
  const idle = vi.fn(); const timing = newSessionTiming({privateDevice:true,idleMinutes:15},Date.now());
  beginSessionActivity(timing); useAutoLock(true,idle,timing);
  vi.advanceTimersByTime(15*60_000-1);expect(idle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);expect(idle).toHaveBeenCalledOnce();
});
it("late input after suspended timers cannot revive an idle session", () => {
  const idle = vi.fn();const timing=newSessionTiming({privateDevice:true,idleMinutes:60},Date.now());
  beginSessionActivity(timing);useAutoLock(true,idle,timing);
  vi.setSystemTime(Date.now()+60*60_000);window.dispatchEvent(new Event("pointerdown"));
  expect(idle).toHaveBeenCalled();
});

it.each([false, true])("samples the idle clock after a storage read; genuinely future=%s", (future) => {
  const timing = newSessionTiming({ privateDevice: true, idleMinutes: 60 }, Date.now());
  beginSessionActivity(timing);
  const get = localStorage.getItem.bind(localStorage);
  vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
    if (key !== "eic.vault-activity.v1") return get(key);
    vi.setSystemTime(Date.now() + 5);
    return JSON.stringify({ id: timing.id, at: Date.now() + (future ? 1 : 0) });
  });
  const idle = vi.fn();
  useAutoLock(true, idle, timing);
  if (!future) window.dispatchEvent(new Event("pointerdown"));
  expect(idle).toHaveBeenCalledTimes(future ? 1 : 0);
});
