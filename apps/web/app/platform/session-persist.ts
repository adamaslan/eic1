import { openDB } from "idb";
import type { VaultKey } from "@veil/core";

/** How long an unlock survives a page reload. */
import type { VaultKey } from "@veil/core";

/** How long an unlock survives a page reload. */
export const SESSION_MS = 60 * 60_000;

const DB_NAME = "veil-session";
const STORE = "session";
const KEY = "current";

export interface PersistedSession {
  key: VaultKey;
  expiresAt: number;
}

const db = () =>
  openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE);
    },
  });

// The key is a non-extractable CryptoKey, stored by structured clone: script on this page can
// use it for the hour but can never read its bytes, and it is deleted on lock, wipe, or expiry.
export async function saveSession(key: VaultKey, now: number): Promise<number> {
  const expiresAt = now + SESSION_MS;
  await (await db()).put(STORE, { key, expiresAt } satisfies PersistedSession, KEY);
  return expiresAt;
}

/** Returns the saved session, or null if there is none or it has expired (expired ones are deleted). */
export async function loadSession(now: number): Promise<PersistedSession | null> {
  const saved = (await (await db()).get(STORE, KEY)) as PersistedSession | undefined;
  if (!saved || typeof saved.expiresAt !== "number" || saved.expiresAt <= now) {
    if (saved) await clearSession();
    return null;
  }
  return saved;
}

export async function clearSession(): Promise<void> {
  let database: Awaited<ReturnType<typeof db>>;
  try {
    database = await db();
  } catch {
    // Storage may be unavailable; then there is nothing saved to clear.
    return;
  }
  // A failed delete means the key is still on disk - callers must hear about it.
  await database.delete(STORE, KEY);
}
