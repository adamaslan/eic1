import type { ChatMessage } from "@veil/features";

// Boundaries of the chat screen's automatic foreground receive, extracted from the route
// so each race the review found is testable in the node environment:
//  - a reload for chat A must never paint over chat B (the screen stays mounted across
//    /chat/:authorId param changes) - createThreadReload;
//  - applied messages must refresh the view before any partial/deferred branch returns -
//    applyCatchUpOutcome;
//  - the tab that loses the cross-tab catch-up lock must refresh when the winner's writes
//    actually land, not before them - withCatchUpLock + handleLockLost + listenForApplied.

export function createThreadReload(deps: {
  markRead: (authorId: string) => Promise<void>;
  loadThread: (authorId: string) => Promise<ChatMessage[]>;
  applyThread: (thread: ChatMessage[]) => void;
  currentAuthorId: () => string | null;
}): (authorId: string) => Promise<void> {
  // Request generation: overlapping reloads for the SAME author (mount + broadcast +
  // contention consume, or an A -> B -> A navigation whose first A load outlives the
  // second) must apply only the latest request's result. Without this, whichever load
  // resolves last paints - and an older snapshot can overwrite a newer one.
  let latest = 0;
  return async (authorId) => {
    const generation = ++latest;
    await deps.markRead(authorId);
    const thread = await deps.loadThread(authorId);
    if (generation !== latest) return;
    // The route may have changed during the awaits above: never paint a stale thread.
    if (deps.currentAuthorId() !== authorId) return;
    deps.applyThread(thread);
  };
}

export interface CatchUpOutcome {
  // Mirrors SyncResult.status from @veil/features sync.
  status: "applied" | "unchanged" | "deferred" | "no-feed" | "failed" | "partial";
  appliedChat: number;
}

/** Zero-storage cross-tab contention marker. Set whenever this tab loses the catch-up
 * lock (the winner may write later); cleared when a reload actually pulls the winner's
 * writes - via the broadcast, the queued-lock acquisition, or consumption by a later
 * unchanged outcome (which would otherwise leave the aborted-wait band durably stale). */
export interface ContentionFlag {
  dirty: boolean;
}

export async function applyCatchUpOutcome(outcome: CatchUpOutcome, deps: {
  active: () => boolean;
  reload: () => Promise<void>;
  /** Cross-tab hook fired after applied writes are committed (broadcast to other tabs).
   * Owed regardless of this tab's visibility or whether its own UI refresh succeeds. */
  onApplied: (count: number) => void;
  onSkipped: () => void;
  onDeferred: () => void;
  onReceived: (count: number) => void;
  onUnchanged: () => void;
  contention?: ContentionFlag;
}): Promise<void> {
  // The writes are already committed when this hook runs: the announcement belongs to
  // other tabs, so it fires even when this tab is hidden or its own reload later fails.
  if (outcome.appliedChat) deps.onApplied(outcome.appliedChat);
  if (!deps.active()) {
    // An applied outcome discarded while hidden must not go stale: the cursor already
    // advanced, so the next poll reads unchanged and a clean flag would skip the reload
    // forever. Retain the refresh debt until a completed refresh consumes it.
    if (outcome.appliedChat && deps.contention) deps.contention.dirty = true;
    return;
  }
  if (outcome.status === "failed") throw new Error("Relay catch-up unavailable");
  // Refresh BEFORE any status branch returns: partial/deferred results can still have
  // applied earlier chat chunks, and later unchanged polls would never show them.
  if (outcome.appliedChat) {
    try {
      await deps.reload();
    } catch (error) {
      // The writes are committed and the cursor already advanced: with a clean flag the
      // next poll reads unchanged and never reloads, so a failed refresh here must RAISE
      // the debt, not merely keep a pre-existing one.
      if (deps.contention) deps.contention.dirty = true;
      throw error;
    }
    // Clear only after the reload actually completed.
    if (deps.contention) deps.contention.dirty = false;
  }
  if (!deps.active()) return;
  if (outcome.status === "partial") { deps.onSkipped(); return; }
  if (outcome.status === "deferred") { deps.onDeferred(); return; }
  if (outcome.appliedChat) deps.onReceived(outcome.appliedChat);
  else {
    // An unchanged read after lost contention means the winner advanced the cursor: its
    // writes are committed but invisible here until we reload. Consume the flag only on
    // a refresh that actually completed; a failed reload keeps it for the next poll.
    if (deps.contention?.dirty) {
      try {
        await deps.reload();
        deps.contention.dirty = false;
      } catch {
        // Still dirty: the next unchanged outcome retries the refresh.
      }
      if (!deps.active()) return;
    }
    deps.onUnchanged();
  }
}

interface LockLike {
  request: (name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => Promise<unknown>;
}

export async function withCatchUpLock(
  locks: LockLike | null,
  name: string,
  options: { pass: () => Promise<void>; onLockLost: () => Promise<void> },
): Promise<void> {
  if (!locks) { await options.pass(); return; }
  await locks.request(name, { ifAvailable: true }, async (held) => {
    if (held) { await options.pass(); return; }
    await options.onLockLost();
  });
}

export interface AppliedChannel {
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  postMessage: (data: unknown) => void;
}

export async function handleLockLost(
  channel: AppliedChannel | null,
  locks: LockLike | null,
  name: string,
  active: () => boolean,
  reload: () => Promise<void>,
  contention?: ContentionFlag,
): Promise<void> {
  // Losing the lock means another tab may commit writes this tab's unchanged polls will
  // never show. Mark it until a reload actually pulls those writes.
  if (contention) contention.dirty = true;
  // With a broadcast channel the winner announces its applied writes after committing;
  // an immediate reload would run before the winner finishes writing, and this tab's
  // later ticks read "unchanged" (the winner advanced the shared cursor), so the stale
  // view would never recover. Wait for the announcement instead.
  if (channel) return;
  // No channel (and no persisted signaling): queue on the SAME Web Lock without
  // ifAvailable. Acquiring it means the winner's pass committed, so refresh exactly once
  // - not another receive pass - then release. Aborted after a bounded wait so a stuck
  // winner cannot wedge this tab; the dirty flag then makes the NEXT unchanged outcome
  // reload, so even a winner that outlasts the wait cannot leave durable staleness.
  if (!locks) { if (active()) await reload(); return; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await locks.request(name, { signal: controller.signal }, async () => {
      // Consume only on an actual refresh: hidden/inactive tabs keep the flag so the
      // next unchanged poll or broadcast performs it instead.
      if (active()) {
        await reload();
        if (contention) contention.dirty = false;
      }
    });
  } catch {
    // AbortError on timeout (or a throwing reload): the flag stays dirty for the next poll.
  } finally {
    clearTimeout(timer);
  }
}

export function listenForApplied(
  channel: AppliedChannel,
  connectionId: string,
  reload: () => void,
): () => void {
  const listener = (event: { data: unknown }) => {
    const data = event.data as { connectionId?: unknown } | null;
    if (data !== null && typeof data === "object" && data.connectionId === connectionId) reload();
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
