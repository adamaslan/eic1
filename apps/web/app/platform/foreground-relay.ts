import { listConnections, syncConnection, type SyncFetcher, type SyncNetwork, type SyncResult } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";

/** One catch-up pass for an open chat. The connection is re-read from the vault at the
 * run boundary: a mount-time snapshot would keep a stale sync cursor, re-download every
 * chunk on every poll, and weaken the rollback guard against replayed older manifests.
 * Returns null when the open page is stale (connection removed, key downgraded, or the
 * feed URL changed under it). Never passes retryFailed: pending outgoing retries stay
 * an explicit user action. */
export async function runForegroundCatchUp(options: {
  vault: UnlockedVault;
  connectionId: string;
  expectedFeedUrl: string;
  fetcher: SyncFetcher;
  network: SyncNetwork;
  newId: () => string;
  now: Date;
}): Promise<SyncResult | null> {
  const fresh = (await listConnections(options.vault)).find((candidate) => candidate.id === options.connectionId);
  if (!fresh?.pubkey || fresh.feedUrl !== options.expectedFeedUrl) return null;
  return syncConnection(options.vault, fresh, {
    fetch: options.fetcher,
    network: options.network,
    newId: options.newId,
    now: options.now,
  });
}

/** Visible/unlocked catch-up only. Not push, background sync, or a capacity promise.
 * One flight at a time, minimum one minute between starts, bounded failure backoff.
 * stop prevents later runs; callers must also guard their vault around awaited work. */
export function startForegroundRelay(options: {
  active: () => boolean;
  run: () => Promise<void>;
  subscribe: (wake: () => void) => () => void;
  intervalMs?: number;
}) {
  const interval = Math.max(60_000, options.intervalMs ?? 60_000);
  let stopped = false;
  let running = false;
  let next = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, Math.max(interval, next - Date.now()));
  };
  const tick = async () => {
    if (stopped || running) return;
    if (!options.active() || Date.now() < next) { schedule(); return; }
    running = true;
    next = Date.now() + interval;
    try { await options.run(); failures = 0; }
    catch { failures = Math.min(failures + 1, 3); }
    finally {
      running = false;
      next = Math.max(next, Date.now() + Math.min(300_000, interval * 2 ** failures));
      schedule();
    }
  };
  const unsubscribe = options.subscribe(() => { void tick(); });
  void tick();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
