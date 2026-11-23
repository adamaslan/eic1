import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { beginSessionActivity, newSessionTiming, recordSessionActivity, sessionIdleRemaining, validPolicy } from "./session-policy";
const BASE = 1_000_000;
let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it("rejects unbounded or malformed policy choices", () => {
  for (const policy of [{privateDevice:"true",idleMinutes:60},{privateDevice:true,idleMinutes:0},{privateDevice:true,idleMinutes:Infinity}]) expect(validPolicy(policy)).toBe(false);
});
it("keeps the original activity timestamp across a fresh module/reload", async () => {
  const timing = newSessionTiming({privateDevice:true,idleMinutes:60},BASE);
  beginSessionActivity(timing);
  expect(recordSessionActivity(timing,BASE+30*60_000)).toBe(true);
  vi.resetModules();
  const fresh = await import("./session-policy");
  expect(fresh.sessionIdleRemaining(timing,BASE+60*60_000)).toBe(30*60_000);
  expect(fresh.sessionIdleRemaining(timing,BASE+90*60_000)).toBe(0);
  expect(fresh.recordSessionActivity(timing,BASE+90*60_000)).toBe(false);
});
it("does not let an older tab overwrite a newer unlock's activity record", () => {
  const old = newSessionTiming({privateDevice:true,idleMinutes:60},BASE);
  beginSessionActivity(old);
  const newer = newSessionTiming({privateDevice:false,idleMinutes:15},BASE+1000);
  beginSessionActivity(newer);
  const record = [...data.values()][0];
  expect(recordSessionActivity(old,BASE+2000)).toBe(true);
  expect([...data.values()][0]).toBe(record);
});
it("fails closed on corrupt/future activity and unavailable storage", () => {
  const timing = newSessionTiming({privateDevice:true,idleMinutes:60},BASE);
  beginSessionActivity(timing);
  const key = [...data.keys()][0];
  data.set(key,"not-json");
  expect(sessionIdleRemaining(timing,BASE+1)).toBe(0);
  data.set(key,JSON.stringify({id:timing.id,at:BASE+100}));
  expect(sessionIdleRemaining(timing,BASE+1)).toBe(0);
  vi.stubGlobal("localStorage",{getItem:()=>{throw new Error("blocked");}});
  expect(recordSessionActivity(timing,BASE+1)).toBe(false);
});
