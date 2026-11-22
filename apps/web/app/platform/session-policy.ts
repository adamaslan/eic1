export const STANDARD_SESSION_MS = 8 * 60 * 60_000;
export const PRIVATE_DEVICE_SESSION_MS = 30 * 24 * 60 * 60_000;
export const IDLE_MINUTES = [15, 60, 480, 1440] as const;
export type IdleMinutes = (typeof IDLE_MINUTES)[number];
export interface SessionPolicy { privateDevice: boolean; idleMinutes: IdleMinutes }
export interface SessionTiming { id: string; startedAt: number; policy: SessionPolicy }
export const DEFAULT_SESSION_POLICY: SessionPolicy = { privateDevice: false, idleMinutes: 60 };
export const MAX_TIMER_MS = 2_147_483_647;
const ACTIVITY_KEY = "eic.vault-activity.v1";
let memoryActivity: { id: string; at: number } | null = null;

export function validPolicy(value: unknown): value is SessionPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as SessionPolicy;
  return typeof policy.privateDevice === "boolean" && IDLE_MINUTES.includes(policy.idleMinutes);
}
export const sessionDuration = (policy: SessionPolicy): number =>
  policy.privateDevice ? PRIVATE_DEVICE_SESSION_MS : STANDARD_SESSION_MS;
export function validTiming(value: unknown, now: number): value is SessionTiming {
  if (!value || typeof value !== "object") return false;
  const timing = value as SessionTiming;
  return typeof timing.id === "string" && timing.id.length > 0 && timing.id.length <= 80
    && Number.isSafeInteger(timing.startedAt) && timing.startedAt >= 0 && timing.startedAt <= now
    && validPolicy(timing.policy);
}
export function newSessionTiming(policy: SessionPolicy, now: number): SessionTiming {
  if (!validPolicy(policy) || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid session policy.");
  return { id: crypto.randomUUID(), startedAt: now, policy: { ...policy } };
}
function storedActivity(): { id: string; at: number } | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ACTIVITY_KEY);
  if (!raw) return null;
  const record = JSON.parse(raw) as { id: unknown; at: unknown };
  if (!record || typeof record.id !== "string" || !Number.isFinite(record.at)) throw new Error("Invalid activity record.");
  return record as { id: string; at: number };
}
/** Activity timestamps are not keys. Only fresh passphrase unlock initializes a new id. */
export function beginSessionActivity(timing: SessionTiming): void {
  memoryActivity = { id: timing.id, at: timing.startedAt };
  if (typeof window !== "undefined") localStorage.setItem(ACTIVITY_KEY, JSON.stringify(memoryActivity));
}
export function lastSessionActivity(timing: SessionTiming, now: number): number {
  try {
    const stored = storedActivity();
    const candidates = [timing.startedAt];
    if (stored?.id === timing.id) candidates.push(stored.at);
    if (memoryActivity?.id === timing.id) candidates.push(memoryActivity.at);
    if (candidates.some((at) => !Number.isFinite(at) || at < timing.startedAt || at > now)) return NaN;
    return Math.max(...candidates);
  } catch { return NaN; }
}
export function sessionIdleRemaining(timing: SessionTiming, now: number): number {
  const last = lastSessionActivity(timing, now);
  return Number.isFinite(last) && Number.isFinite(now) ? timing.policy.idleMinutes * 60_000 - (now - last) : 0;
}
/** A late input cannot revive an idle session. Older tabs never overwrite a newer session's record. */
export function recordSessionActivity(timing: SessionTiming, now: number): boolean {
  if (sessionIdleRemaining(timing, now) <= 0) return false;
  try {
    const stored = storedActivity();
    memoryActivity = { id: timing.id, at: now };
    if (typeof window !== "undefined" && (!stored || stored.id === timing.id)) {
      localStorage.setItem(ACTIVITY_KEY, JSON.stringify(memoryActivity));
    }
    return true;
  } catch { return false; }
}
export function clearSessionActivity(): void {
  memoryActivity = null;
  try { if (typeof window !== "undefined") localStorage.removeItem(ACTIVITY_KEY); } catch { /* revocation still fails closed */ }
}
