import { openDB } from "idb";
import type { VaultKey } from "@veil/core";
import { STANDARD_SESSION_MS, DEFAULT_SESSION_POLICY, beginSessionActivity, clearSessionActivity, newSessionTiming, sessionDuration, sessionIdleRemaining, validTiming, currentSessionActivityId, hasReplacedSessionActivity, type SessionTiming } from "./session-policy";

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
  const transaction = (await db()).transaction(STORE, "readwrite");
  try {
    // Another tab may have replaced the session while opening the database.
    if (currentSessionActivityId() !== timing.id) throw new Error("The remembered session was superseded while saving.");
    await transaction.store.put({ key, expiresAt, lockMarker, timing } satisfies PersistedSession, KEY);
    if (currentLockMarker() !== lockMarker || currentSessionActivityId() !== timing.id) {
      // No competing write can commit between our put and this deletion.
      await transaction.store.delete(KEY);
      await transaction.done;
      throw new Error("The remembered session was revoked while saving.");
    }
    await transaction.done;
  } catch (error) {
    await transaction.done.catch(() => {});
    throw error;
  }
  return expiresAt;
}

/** Legacy records keep their earlier deadline; only explicit new opt-in can create a thirty-day record. */
export async function loadSession(now: number | (() => number)): Promise<(PersistedSession & { timing: SessionTiming }) | null> {
  const transaction = (await db()).transaction(STORE, "readwrite");
  try {
    const saved = await transaction.store.get(KEY) as PersistedSession | undefined;
    if (!saved) { await transaction.done; return null; }
    // Real callers sample after the async read; numeric clocks stay fixed for controlled tests.
    const checkedAt = typeof now === "function" ? now() : now;
    const legacy = saved.timing === undefined;
    const timing = legacy
      ? { id: `legacy:${saved.expiresAt}`, startedAt: Math.max(0, saved.expiresAt - SESSION_MS), policy: { ...DEFAULT_SESSION_POLICY } }
      : saved.timing;
    if (currentLockMarker() === "storage-unavailable" || !Number.isFinite(saved.expiresAt)
      || !validTiming(timing, checkedAt) || saved.expiresAt <= checkedAt
      || (legacy ? saved.expiresAt > checkedAt + SESSION_MS : saved.expiresAt !== timing.startedAt + sessionDuration(timing.policy))
      || hasReplacedSessionActivity(timing) || sessionIdleRemaining(timing, now) <= 0
      || (saved.lockMarker ?? null) !== currentLockMarker()) {
      // Read, reject and delete are one transaction. Never clear newer activity.
      await transaction.store.delete(KEY);
      await transaction.done;
      return null;
    }
    await transaction.done;
    return { ...saved, timing };
  } catch (error) {
    await transaction.done.catch(() => {});
    throw error;
  }
}

/** Removes only the saved key for the latest unlock attempt, not its activity.
 * A durable activity id fences an older saved key even when deletion refuses. */
export async function discardSavedSession(timing: SessionTiming): Promise<boolean> {
  const transaction = (await db()).transaction(STORE, "readwrite");
  try {
    const saved = await transaction.store.get(KEY);
    if (saved && currentSessionActivityId() !== timing.id) {
      await transaction.done;
      return false;
    }
    if (saved) await transaction.store.delete(KEY);
    await transaction.done;
    return true;
  } catch (error) {
    await transaction.done.catch(() => {});
    throw error;
  }
}

export async function clearSession(expectedTiming?: SessionTiming): Promise<void> {
  if (expectedTiming) {
    const transaction = (await db()).transaction(STORE, "readwrite");
    try {
      const saved = await transaction.store.get(KEY) as PersistedSession | undefined;
      if (saved?.timing?.id === expectedTiming.id) await transaction.store.delete(KEY);
      // Conditional/stale cleanup never clears the latest unlock's activity.
      await transaction.done;
      return;
    } catch (error) {
      await transaction.done.catch(() => {});
      throw error;
    }
  }
  const previousActivity = currentSessionActivityId();
  clearSessionActivity();
  let database: Awaited<ReturnType<typeof db>>;
  try { database = await db(); }
  catch { return; }
  const transaction = database.transaction(STORE, "readwrite");
  try {
    const activity = currentSessionActivityId();
    // A fresh unlock after this lock request owns its replacement record.
    if (activity == null || activity === previousActivity) await transaction.store.delete(KEY);
    await transaction.done;
  } catch (error) {
    await transaction.done.catch(() => {});
    throw error;
  }
}

export function currentLockMarker(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem("eic.vault-lock"); } catch { return "storage-unavailable"; }
}
