import { AppError, VaultCorruptError, type Connection } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { applyInboundChatEnvelope } from "./chat";
import {
  chunkUrl,
  isValidFeedUrl,
  manifestUrl,
  parseFeedChatChunk,
  parseFeedManifest,
  verifyFeedChunk,
  verifyFeedManifest,
} from "./feed";
import { importShareBundle } from "./sharing";
import { listConnections, loadSettings, setConnectionSyncState } from "./social";

// Pull sync (spec section 3, transport J = pull): each connection publishes a signed eic-feed to
// a static URL; this vault fetches the manifest conditionally (etag, then seq), verifies it
// against the connection's pinned key, fetches chunks whose hashes are pinned in the manifest,
// and applies them idempotently. The network is only a catch-up layer - rendering is always from
// local records. Wi-fi only by default; oversized chunks defer on cellular.

export const CELLULAR_CHUNK_BUDGET_BYTES = 1024 * 1024;

export interface SyncFetchResponse {
  status: number;
  etag: string | null;
  text: string | null;
}

/** Injected so tests can serve feeds from memory and the app can use fetch. */
export type SyncFetcher = (url: string, etag: string | null) => Promise<SyncFetchResponse>;

export type SyncNetwork = "wifi" | "cellular";

export interface SyncDeps {
  fetch: SyncFetcher;
  network: SyncNetwork;
  newId: () => string;
  now: Date;
  // Test seam: overrides the cellular chunk byte budget.
  chunkBudgetBytes?: number;
}

export interface SyncResult {
  status: "applied" | "unchanged" | "deferred" | "no-feed" | "failed" | "partial";
  appliedPosts: number;
  appliedChat: number;
  pendingChunks: string[];
  rejectedChunks: string[];
  error?: string;
}

export async function syncConnection(vault: UnlockedVault, connection: Connection, deps: SyncDeps): Promise<SyncResult> {
  const settings = await loadSettings(vault);
  if (!settings.authorId) throw new AppError("Choose a handle before syncing.");
  if (!connection.feedUrl) return { status: "no-feed", appliedPosts: 0, appliedChat: 0, pendingChunks: [], rejectedChunks: [] };
  if (!isValidFeedUrl(connection.feedUrl)) throw new AppError("That connection's feed URL must be an https URL (http is allowed only for localhost).");
  if (!connection.pubkey) throw new AppError("This connection has no verified key.");
  if (deps.network === "cellular" && !settings.syncOnCellular) {
    return { status: "deferred", appliedPosts: 0, appliedChat: 0, pendingChunks: [], rejectedChunks: [] };
  }

  // Pending chunks from a cellular-deferred pull must be retried: skip the etag shortcut and
  // re-apply the same manifest (chunk application is idempotent), so delivery does not depend
  // on the sender republishing.
  const head = await deps.fetch(manifestUrl(connection.feedUrl), connection.syncPending ? null : connection.syncEtag);
  if (head.status === 304) return { status: "unchanged", appliedPosts: 0, appliedChat: 0, pendingChunks: [], rejectedChunks: [] };
  if (head.status !== 200 || head.text === null) {
    throw new VaultCorruptError(`The feed could not be fetched (status ${head.status}).`);
  }
  const manifest = parseFeedManifest(head.text);
  await verifyFeedManifest(manifest, connection.id, connection.pubkey);
  // Rollback protection: a signed manifest at a lower seq than we already applied could be a
  // replayed stale snapshot, and accepting it would silently resurrect deleted posts and discard
  // newer ones. signedAt/builtAt cannot prove freshness across clock skew, so recovery after a
  // vault rebuild stays explicit: the author re-shares and the reader re-imports, which clears the
  // cursor. Ordinary sync at equal-or-higher seq is unaffected.
  if (manifest.seq < connection.syncSeq) {
    throw new VaultCorruptError(
      "That feed published an older sequence than the one already applied, so it was not rolled back. If the author rebuilt their vault, ask them to re-share and re-import their bundle to reset.",
    );
  }
  if (manifest.seq === connection.syncSeq && !connection.syncPending) {
    await setConnectionSyncState(vault, connection.id, {
      seq: connection.syncSeq,
      etag: head.etag ?? connection.syncEtag,
      pending: connection.syncPending,
    });
    return { status: "unchanged", appliedPosts: 0, appliedChat: 0, pendingChunks: [], rejectedChunks: [] };
  }

  let appliedPosts = 0;
  let appliedChat = 0;
  const pendingChunks: string[] = [];
  const rejectedChunks: string[] = [];
  for (const ref of manifest.chunks) {
    if (deps.network === "cellular" && ref.bytes > (deps.chunkBudgetBytes ?? CELLULAR_CHUNK_BUDGET_BYTES)) {
      pendingChunks.push(ref.id);
      continue;
    }
    // A chunk that cannot be fetched (network/5xx/404) is transient: defer it and retry on
    // the next pull, exactly like a cellular-deferred chunk. Only content-level failures are
    // terminal.
    const res = await deps.fetch(chunkUrl(connection.feedUrl, ref.id), null);
    if (res.status !== 200 || res.text === null) {
      pendingChunks.push(ref.id);
      continue;
    }
    try {
      await verifyFeedChunk(ref, res.text);
      if (ref.kind !== "chat" && ref.kind !== "posts" && ref.kind !== "likes") {
        // Unknown chunk kind from a newer feed version: skip it, keep everything else moving.
        continue;
      }
      if (ref.kind === "chat") {
        for (const envelope of parseFeedChatChunk(res.text)) {
          const e = envelope as { recipientAuthorId?: unknown } | null;
          if (e?.recipientAuthorId !== settings.authorId) continue;
          try {
            const applied = await applyInboundChatEnvelope(vault, envelope, { newId: deps.newId, now: () => deps.now });
            if (applied.applied) appliedChat += 1;
          } catch {
            // A chunk can carry envelopes for connections whose keys rotated; one bad envelope
            // must not fail the whole sync. Others still apply.
          }
        }
      } else {
        const result = await importShareBundle(vault, res.text, { settings, newId: deps.newId, now: deps.now });
        appliedPosts += result.added + result.updated;
      }
    } catch (caught) {
      // A chunk that fails integrity/signature/parse/apply is terminally rejected for this
      // manifest: it is not retried (the cursor advances past it) and does not masquerade as
      // a transient deferral. A corrected republish arrives under a newer seq and is applied
      // then. Other chunks and other connections keep moving.
      rejectedChunks.push(ref.id);
      continue;
    }
  }

  const status =
    pendingChunks.length > 0 ? "deferred" : rejectedChunks.length > 0 ? "partial" : "applied";
  const detail =
    rejectedChunks.length > 0 ? `rejected: ${rejectedChunks.join(", ")}` : pendingChunks.length > 0 ? `pending: ${pendingChunks.join(", ")}` : "";
  await setConnectionSyncState(vault, connection.id, {
    seq: manifest.seq,
    etag: head.etag ?? connection.syncEtag,
    pending: pendingChunks.length > 0,
    status,
    detail,
  });
  return {
    status,
    appliedPosts,
    appliedChat,
    pendingChunks,
    rejectedChunks,
  };
}

export async function syncAllConnections(vault: UnlockedVault, deps: SyncDeps): Promise<Map<string, SyncResult>> {
  const results = new Map<string, SyncResult>();
  for (const connection of await listConnections(vault)) {
    if (connection.hidden) continue;
    try {
      results.set(connection.id, await syncConnection(vault, connection, deps));
    } catch (error) {
      // One corrupt or unreachable feed must not abort the remaining peers.
      const detail = error instanceof Error ? error.message : String(error);
      results.set(connection.id, {
        status: "failed",
        appliedPosts: 0,
        appliedChat: 0,
        pendingChunks: [],
        rejectedChunks: [],
        error: detail,
      });
      // Persist the failure so the user-visible sync status is honest instead of stale-ok.
      await setConnectionSyncState(vault, connection.id, {
        seq: connection.syncSeq,
        etag: connection.syncEtag,
        pending: connection.syncPending,
        status: "failed",
        detail,
      });
    }
  }
  return results;
}
