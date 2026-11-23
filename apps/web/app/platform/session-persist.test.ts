import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultKey } from "@veil/core";
const storage = vi.hoisted(() => ({ value: undefined as unknown, refuse: false, afterPut: null as (() => void) | null }));
vi.mock("idb", () => ({ openDB: async () => {
  const put = async (_store: string, value: unknown) => { if (storage.refuse) throw new Error("storage refused"); storage.value = value; storage.afterPut?.(); };
  const get = async () => storage.value;
  const remove = async () => { storage.value = undefined; };
  return { put, get, delete: remove,
    transaction: () => ({ store: { get, put: (value: unknown) => put("session", value), delete: remove }, done: Promise.resolve() }),
  };
} }));
import { SESSION_MS, clearSession, loadSession, saveSession } from "./session-persist";
import { clearSessionActivity, recordSessionActivity } from "./session-policy";
const key = {} as VaultKey;
describe("bounded remembered sessions", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => { clearSessionActivity(); storage.value = undefined; storage.refuse = false; storage.afterPut = null; });
  it("uses exactly eight hours, and reads never renew the deadline", async () => {
    expect(SESSION_MS).toBe(28_800_000);
    expect(await saveSession(key, 1_000, { id: "standard-longer-idle", startedAt: 1_000, policy: { privateDevice: false, idleMinutes: 1440 } })).toBe(28_801_000);
    expect((await loadSession(1_000 + SESSION_MS - 1))?.expiresAt).toBe(28_801_000);
    expect(await loadSession(1_000 + SESSION_MS)).toBeNull();
    expect(storage.value).toBeUndefined();
  });
  it("keeps an older one-hour session's earlier expiry", async () => {
    storage.value = { key, expiresAt: 3_601_000 };
    expect((await loadSession(2_000))?.expiresAt).toBe(3_601_000);
    expect(await loadSession(3_601_000)).toBeNull();
  });
  it("supports an explicitly chosen fixed thirty-day private-device window", async () => {
    const timing = { id: "synthetic-private-device", startedAt: 1_000, policy: { privateDevice: true, idleMinutes: 60 as const } };
    expect(await saveSession(key, 1_000, timing)).toBe(1_000 + 30 * 24 * 60 * 60_000);
  });
  it("keeps the default one-hour idle lock even with a thirty-day window", async () => {
    const timing = { id: "private-default-idle", startedAt: 1_000, policy: { privateDevice: true, idleMinutes: 60 as const } };
    await saveSession(key, 1_000, timing);
    expect(await loadSession(1_000 + 60 * 60_000 - 1)).not.toBeNull();
    expect(await loadSession(1_000 + 60 * 60_000)).toBeNull();
  });
  it("resumes beyond eight hours after genuine activity, without extending thirty days", async () => {
    const timing = { id: "private-active", startedAt: 1_000, policy: { privateDevice: true, idleMinutes: 1440 as const } };
    const deadline = await saveSession(key, 1_000, timing);
    for (let halfDay = 1; halfDay <= 59; halfDay++) {
      const now = 1_000 + halfDay * 12 * 60 * 60_000;
      expect(recordSessionActivity(timing, now)).toBe(true);
      expect((await loadSession(now))?.expiresAt).toBe(deadline);
    }
    expect(await loadSession(deadline)).toBeNull();
  });
  it("rejects altered policy, deadline or future start metadata", async () => {
    await saveSession(key, 1_000);
    const good = structuredClone(storage.value) as Record<string, unknown>;
    for (const bad of [
      { ...good, expiresAt: 1_000 + 30 * 24 * 60 * 60_000 },
      { ...good, timing: { id: "bad", startedAt: 1_000, policy: { privateDevice: "true", idleMinutes: 60 } } },
      { ...good, timing: { id: "bad", startedAt: 3_000, policy: { privateDevice: true, idleMinutes: 60 } } },
    ]) { storage.value = bad; expect(await loadSession(2_000)).toBeNull(); }
  });
  it("manual lock removes the saved key", async () => {
    await saveSession(key, 1_000);
    await clearSession();
    expect(await loadSession(2_000)).toBeNull();
  });
  it("rejects corrupt or out-of-range deadlines instead of staying unlocked forever", async () => {
    for (const expiresAt of [NaN, Infinity, -Infinity, "future", 28_801_001]) {
      storage.value = { key, expiresAt };
      expect(await loadSession(1_000)).toBeNull();
      expect(storage.value).toBeUndefined();
    }
  });
  it("propagates persistence refusal so the caller cannot claim a saved session", async () => {
    storage.refuse = true;
    await expect(saveSession(key, 1_000)).rejects.toThrow("storage refused");
    expect(storage.value).toBeUndefined();
  });
  it("rejects a revoked saved key even when its asynchronous deletion has not completed", async () => {
    let marker: string | null = null;
    vi.stubGlobal("window", {});
    const activity = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (name: string) => name === "eic.vault-lock" ? marker : activity.get(name) ?? null, setItem: (name: string, value: string) => activity.set(name, value), removeItem: (name: string) => activity.delete(name) });
    await saveSession(key, 1_000);
    marker = "locked-now";
    expect(await loadSession(2_000)).toBeNull();
    expect(storage.value).toBeUndefined();
  });

  it("does not leave a saved key if Manual Lock races the persistence write", async () => {
    let marker = "A"; const data = new Map<string, string>();
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {getItem:(key:string)=>key==="eic.vault-lock"?marker:data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)});
    storage.afterPut = () => { marker = "B"; };
    await expect(saveSession(key,1_000)).rejects.toThrow("revoked");
    expect(storage.value).toBeUndefined();
  });

  it("fails closed when localStorage is blocked but IndexedDB still returns a key", async () => {
    storage.value = { key, expiresAt: 3_601_000, lockMarker: "storage-unavailable" };
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(await loadSession(2_000)).toBeNull();
    expect(storage.value).toBeUndefined();
    await expect(saveSession(key, 2_000)).rejects.toThrow(/unavailable/);
  });

});
