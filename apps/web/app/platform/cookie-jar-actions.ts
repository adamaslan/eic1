import { rowsFor, webStorageRefs, PROTECTED_KEYS, refMatches } from "./purpose-registry";

// The five Cookie Jar actions. Each names exactly the registry rows it touches (I-1).
// Nothing here calls localStorage.clear() or sends Clear-Site-Data.

export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

function keysOf(store: KeyValueStore): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

export interface ClearReport {
  removed: string[];
  /** Keys that matched a protected security row and were left alone. */
  kept: string[];
}

/**
 * Clear preferences: removes only keys that a `clear-preferences` registry row owns.
 * A key that is protected (vault, session, lock, activity) is never removed even if a
 * registry mistake listed it, so I-1 holds by construction and by test.
 */
export function clearPreferences(local: KeyValueStore, session: KeyValueStore): ClearReport {
  const refs = webStorageRefs(rowsFor("clear-preferences"));
  const removed: string[] = [];
  const kept: string[] = [];
  for (const [kind, store] of [["localStorage", local], ["sessionStorage", session]] as const) {
    for (const key of keysOf(store)) {
      if (!refs.some((ref) => refMatches(ref, kind, key))) continue;
      if (PROTECTED_KEYS.includes(key)) {
        kept.push(key);
        continue;
      }
      try {
        store.removeItem(key);
        removed.push(key);
      } catch {
        // Blocked storage: nothing to clear, and nothing we would claim to have cleared.
      }
    }
  }
  return { removed, kept };
}

/**
 * "Forget remembered access": deletes the saved session key AND locks every open tab, so the
 * current in-memory access cannot outlive the choice. Locking runs even if deleting the key
 * throws (fail closed). The vault content is never touched.
 */
export async function forgetRememberedAccess(options: { clearSession: () => Promise<void>; lock: () => Promise<void> }): Promise<void> {
  try {
    await options.clearSession();
  } finally {
    await options.lock();
  }
}

export const ERASE_CONFIRMATION = "ERASE";

export type EraseOutcome = "erased" | "needs-confirmation" | "locked";

/**
 * Erase vault: destructive. Requires an unlocked vault and the typed word, so a stray tap
 * or a script cannot trigger it. The caller offers an encrypted export first.
 */
export async function eraseVault(options: {
  typed: string;
  wipe: (() => Promise<void>) | null;
  clearSession: () => Promise<void>;
}): Promise<EraseOutcome> {
  if (options.typed.trim() !== ERASE_CONFIRMATION) return "needs-confirmation";
  if (!options.wipe) return "locked";
  await options.wipe();
  await options.clearSession();
  return "erased";
}
