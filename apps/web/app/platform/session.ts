import { create } from "zustand";
import { VaultLockedError } from "@veil/core";
import { flushSync } from "react-dom";
import type { UnlockedVault } from "@veil/vault";
import { SESSION_MS, clearSession } from "./session-persist";

interface SessionState {
  vault: UnlockedVault | null;
  /** When the eight-hour session ends (ms since epoch). Null while locked. */
  expiresAt: number | null;
  /** True until the first check for a session saved before a reload has finished. */
  resuming: boolean;
  /** Bumped on every unlock and lock, so a slow resume cannot apply a stale vault. */
  revision: number;
  setVault: (vault: UnlockedVault, expiresAt?: number) => void;
  doneResuming: () => void;
  lock: () => Promise<void>;
}

// Holds the unlocked vault in memory. The key behind it may also be kept for SESSION_MS so a reload
// does not ask for the passphrase again (see session-persist.ts); locking always removes it.
export const useSessionStore = create<SessionState>((set) => ({
  vault: null,
  expiresAt: null,
  resuming: true,
  revision: 0,
  setVault: (vault, expiresAt = Date.now() + SESSION_MS) =>
    set((state) => {
      lockMarkerAtUnlock = readLockMarker();
      return { vault: guardedVault(vault, expiresAt, lockMarkerAtUnlock), expiresAt, resuming: false, revision: state.revision + 1 };
    }),
  doneResuming: () => set({ resuming: false }),
  lock: () => lockSession(true),
}));

// Only a lock signal crosses tabs, never a key or vault contents. Session key deletion
// alone cannot lock another tab that already holds an in-memory vault.
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("eic-vault-lock") : null;
function announceLock(): void {
  channel?.postMessage("lock");
  try { localStorage.setItem("eic.vault-lock", `${Date.now()}:${Math.random()}`); } catch { /* optional fallback */ }
}
if (typeof window !== "undefined") {
  if (channel) channel.onmessage = (event) => {
    if (event.data === "lock") void lockSession(false);
  };
  const checkReturn = () => {
    // Hide while backgrounded so a resumed page never offers stale decrypted DOM
    // before this synchronous revocation check and React commit.
    if (document.visibilityState === "hidden") { document.body.style.visibility = "hidden"; return; }
    const state = useSessionStore.getState();
    if (state.vault && (readLockMarker() === "storage-unavailable" || readLockMarker() !== lockMarkerAtUnlock || state.expiresAt === null || Date.now() >= state.expiresAt)) {
      flushSync(() => { void lockSession(false); });
    }
    document.body.style.visibility = "";
  };
  window.addEventListener("focus", checkReturn);
  window.addEventListener("pageshow", checkReturn);
  document.addEventListener("visibilitychange", checkReturn);
  window.addEventListener("storage", (event) => {
    if (event.key === "eic.vault-lock" && event.newValue) void lockSession(false);
  });
}

async function lockSession(announce: boolean): Promise<void> {
  if (announce) announceLock();
  useSessionStore.getState().vault?.lock();
  useSessionStore.setState((state) => ({ vault: null, expiresAt: null, revision: state.revision + 1 }));
  try { await clearSession(); }
  catch (err) { console.error("veil: saved session key could not be deleted", err); }
}

let lockMarkerAtUnlock: string | null = null;
function readLockMarker(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem("eic.vault-lock"); }
  catch { return "storage-unavailable"; }
}
function guardedVault(vault: UnlockedVault, expiresAt: number, marker: string | null): UnlockedVault {
  return new Proxy(vault, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function" || property === "lock") return value;
    return (...args: unknown[]) => {
      if (Date.now() >= expiresAt || readLockMarker() !== marker) {
        void lockSession(false);
        throw new VaultLockedError("The vault is locked.");
      }
      return value.apply(target, args);
    };
  } });
}
