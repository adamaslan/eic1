import { create } from "zustand";
import type { UnlockedVault } from "@veil/vault";

interface SessionState {
  vault: UnlockedVault | null;
  setVault: (vault: UnlockedVault) => void;
  lock: () => void;
}

// Holds the unlocked vault in memory only. Nothing here is persisted.
export const useSessionStore = create<SessionState>((set, get) => ({
  vault: null,
  setVault: (vault) => set({ vault }),
  lock: () => {
    get().vault?.lock();
    set({ vault: null });
  },
}));
