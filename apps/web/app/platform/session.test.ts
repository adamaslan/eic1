import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearSession = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("./session-persist", () => ({
  SESSION_MS: 28_800_000,
  clearSession,
}));

import { useSessionStore } from "./session";

const fakeVault = () => ({ lock: vi.fn() }) as never;

describe("session store", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    clearSession.mockReset().mockResolvedValue(undefined);
    useSessionStore.setState({ vault: null, expiresAt: null, resuming: true, revision: 0 });
  });

  it("lock drops the vault, bumps the revision, and waits for the key deletion", async () => {
    let deleted = false;
    clearSession.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(() => { deleted = true; resolve(); }, 0)),
    );
    const vault = fakeVault();
    useSessionStore.getState().setVault(vault);
    const revision = useSessionStore.getState().revision;

    await useSessionStore.getState().lock();

    expect(deleted).toBe(true);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().vault).toBeNull();
    expect(useSessionStore.getState().expiresAt).toBeNull();
    expect(useSessionStore.getState().revision).toBe(revision + 1);
    expect((vault as { lock: ReturnType<typeof vi.fn> }).lock).toHaveBeenCalled();
  });

  it("lock reports a failed key deletion instead of throwing", async () => {
    clearSession.mockRejectedValue(new Error("delete failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(useSessionStore.getState().lock()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith("veil: saved session key could not be deleted", expect.any(Error));
    expect(useSessionStore.getState().vault).toBeNull();
    errSpy.mockRestore();
  });

  it("every unlock and lock advances the revision, so a stale resume can be detected", async () => {
    const start = useSessionStore.getState().revision;
    useSessionStore.getState().setVault(fakeVault());
    await useSessionStore.getState().lock();
    useSessionStore.getState().setVault(fakeVault());
    expect(useSessionStore.getState().revision).toBe(start + 3);
  });
  it("blocks expired vault operations even before a delayed expiry timer fires", () => {
    const read = vi.fn();
    const vault = { lock: vi.fn(), getJson: read } as unknown as import("@veil/vault").UnlockedVault;
    useSessionStore.getState().setVault(vault, Date.now() - 1);
    expect(() => useSessionStore.getState().vault!.getJson("private")).toThrow("The vault is locked.");
    expect(read).not.toHaveBeenCalled();
    expect(useSessionStore.getState().vault).toBeNull();
  });

  it("blocks a new operation immediately if revocation storage becomes unavailable without focus events", () => {
    const read = vi.fn();
    useSessionStore.getState().setVault({ lock: vi.fn(), getJson: read } as unknown as import("@veil/vault").UnlockedVault);
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(() => useSessionStore.getState().vault!.getJson("private")).toThrow("The vault is locked.");
    expect(read).not.toHaveBeenCalled();
    expect(useSessionStore.getState().vault).toBeNull();
  });

});
