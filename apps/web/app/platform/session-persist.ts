import { openDB } from "idb";
import type { VaultKey } from "@veil/core";
import { STANDARD_SESSION_MS, DEFAULT_SESSION_POLICY, beginSessionActivity, clearSessionActivity, newSessionTiming, sessionDuration, sessionIdleRemaining, validTiming, type SessionTiming } from "./session-policy";

/** How long an unlock survives a page reload. */
export const SESSION_MS = STANDARD_SESSION_MS;

const DB_NAME = "veil-session";
const STORE = "session";
const KEY = "current";

export interface PersistedSession {
  key: VaultKey;
  expiresAt: number;
  lockMarker?: string | null;
  timing?: SessionTiming;
}

const db = () =>
  openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE);
    },
  });

// The non-extractable key stays on this device for a fixed chosen window, never a sliding expiry.
export async function saveSession(key: VaultKey, now: number, timing = newSessionTiming(DEFAULT_SESSION_POLICY, now)): Promise<number> {
  if (!validTiming(timing, now) || timing.startedAt !== now) throw new Error("Invalid session timing.");
  const expiresAt = now + sessionDuration(timing.policy);
  const lockMarker = currentLockMarker();
  if (lockMarker === "storage-unavailable") throw new Error("Session revocation storage is unavailable.");
  beginSessionActivity(timing);
  await (await db()).put(STORE, { key, expiresAt, lockMarker, timing } satisfies PersistedSession, KEY);
  if (currentLockMarker() !== lockMarker) {
    await clearSession();
    throw new Error("The remembered session was revoked while saving.");
  }
  return expiresAt;
}

/** Legacy records keep their earlier deadline; only explicit new opt-in can create a thirty-day record. */
export async function loadSession(now: number): Promise<(PersistedSession & { timing: SessionTiming }) | null> {
  const saved = (await (await db()).get(STORE, KEY)) as PersistedSession | undefined;
  if (!saved) return null;
  const legacy = saved.timing === undefined;
  const timing = legacy
    ? { id: `legacy:${saved.expiresAt}`, startedAt: Math.max(0, saved.expiresAt - SESSION_MS), policy: { ...DEFAULT_SESSION_POLICY } }
    : saved.timing;
  if (currentLockMarker() === "storage-unavailable" || !Number.isFinite(saved.expiresAt)
    || !validTiming(timing, now) || saved.expiresAt <= now
    || (legacy ? saved.expiresAt > now + SESSION_MS : saved.expiresAt !== timing.startedAt + sessionDuration(timing.policy))
    || sessionIdleRemaining(timing, now) <= 0 || (saved.lockMarker ?? null) !== currentLockMarker()) {
    await clearSession();
    return null;
  }
  return { ...saved, timing };
}

export async function clearSession(): Promise<void> {
  clearSessionActivity();
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

export function currentLockMarker(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem("eic.vault-lock"); } catch { return "storage-unavailable"; }
}
