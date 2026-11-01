import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultKey } from "@veil/core";
const storage = vi.hoisted(() => ({ value: undefined as unknown, refuse: false }));
vi.mock("idb", () => ({ openDB: async () => ({
  put: async (_store: string, value: unknown) => { if (storage.refuse) throw new Error("storage refused"); storage.value = value; },
  get: async () => storage.value,
  delete: async () => { storage.value = undefined; },
}) }));
import { SESSION_MS, clearSession, loadSession, saveSession } from "./session-persist";
const key = {} as VaultKey;
describe("fixed eight-hour remembered session", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => { storage.value = undefined; storage.refuse = false; });
  it("uses exactly eight hours, and reads never renew the deadline", async () => {
    expect(SESSION_MS).toBe(28_800_000);
    expect(await saveSession(key, 1_000)).toBe(28_801_000);
    expect((await loadSession(1_000 + SESSION_MS - 1))?.expiresAt).toBe(28_801_000);
    expect(await loadSession(1_000 + SESSION_MS)).toBeNull();
    expect(storage.value).toBeUndefined();
  });
  it("keeps an older one-hour session's earlier expiry", async () => {
    storage.value = { key, expiresAt: 3_601_000 };
    expect((await loadSession(2_000))?.expiresAt).toBe(3_601_000);
    expect(await loadSession(3_601_000)).toBeNull();
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
    vi.stubGlobal("localStorage", { getItem: () => marker });
    await saveSession(key, 1_000);
    marker = "locked-now";
    expect(await loadSession(2_000)).toBeNull();
    expect(storage.value).toBeUndefined();
  });

});
