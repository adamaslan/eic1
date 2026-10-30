import { create } from "zustand";
import type { UnlockedVault } from "@veil/vault";
import { SESSION_MS, clearSession } from "./session-persist";

interface SessionState {
  vault: UnlockedVault | null;
  /** When the one-hour session ends (ms since epoch). Null while locked. */
  expiresAt: number | null;
  /** True until the first check for a session saved before a reload has finished. */
  resuming: boolean;
  setVault: (vault: UnlockedVault, expiresAt?: number) => void;
  doneResuming: () => void;
  lock: () => void;
}

// Holds the unlocked vault in memory. The key behind it may also be kept for SESSION_MS so a reload
// does not ask for the passphrase again (see session-persist.ts); locking always removes it.
export const useSessionStore = create<SessionState>((set, get) => ({
  vault: null,
  expiresAt: null,
  resuming: true,
  setVault: (vault, expiresAt = Date.now() + SESSION_MS) => set({ vault, expiresAt, resuming: false }),
  doneResuming: () => set({ resuming: false }),
  lock: () => {
    get().vault?.lock();
    set({ vault: null, expiresAt: null });
    void clearSession();
  },
}));
