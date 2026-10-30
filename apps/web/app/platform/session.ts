import { create } from "zustand";
import type { UnlockedVault } from "@veil/vault";
import { SESSION_MS, clearSession } from "./session-persist";

interface SessionState {
  vault: UnlockedVault | null;
  /** When the one-hour session ends (ms since epoch). Null while locked. */
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
export const useSessionStore = create<SessionState>((set, get) => ({
  vault: null,
  expiresAt: null,
  resuming: true,
  revision: 0,
  setVault: (vault, expiresAt = Date.now() + SESSION_MS) =>
    set((state) => ({ vault, expiresAt, resuming: false, revision: state.revision + 1 })),
  doneResuming: () => set({ resuming: false }),
  lock: async () => {
    get().vault?.lock();
    set((state) => ({ vault: null, expiresAt: null, revision: state.revision + 1 }));
    try {
      await clearSession();
    } catch (err) {
      // The in-memory vault is already dropped, so the vault is locked now; but the saved key
      // survived and a reload could resume it. Loud, and the next lock/expiry retries the delete.
      console.error("veil: saved session key could not be deleted", err);
    }
  },
}));
