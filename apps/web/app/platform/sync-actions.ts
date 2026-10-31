import type { Connection } from "@veil/core";
import type { SyncDeps, SyncResult } from "@veil/features";
import { syncAllConnections, syncConnection } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";
import { newItemId } from "~/platform/vault-service";
import { detectSyncNetwork, httpSyncFetcher } from "~/platform/sync-fetcher";

/**
 * Normal sync: honors settled cursors (conditional fetch) and accumulated fetch retry
 * budgets, so permanently-unreachable chunks still exhaust. Never passes retryFailed.
 */
export function normalSyncDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { fetch: httpSyncFetcher, network: detectSyncNetwork(), newId: newItemId, now: new Date(), ...overrides };
}

/** Explicit user retry for one exhausted feed: restarts that feed's fetch retry budget
 *  and bypasses its etag shortcut. Signature verification and rollback protection still
 *  apply; integrity-rejected chunks stay terminal. */
export function explicitRetryDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { ...normalSyncDeps(overrides), retryFailed: true };
}

export async function syncAllNormally(vault: UnlockedVault, overrides: Partial<SyncDeps> = {}): Promise<Map<string, SyncResult>> {
  return syncAllConnections(vault, normalSyncDeps(overrides));
}

export async function retryConnectionFailedChunks(vault: UnlockedVault, connection: Connection, overrides: Partial<SyncDeps> = {}): Promise<SyncResult> {
  return syncConnection(vault, connection, explicitRetryDeps(overrides));
}

/** Structured persisted signal for the "retry failed chunks" affordance - never parse the
 *  user-visible detail string for control flow. */
export function isFetchExhausted(connection: Connection): boolean {
  return connection.syncExhausted;
}
