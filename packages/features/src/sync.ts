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
  status: "applied" | "unchanged" | "deferred" | "no-feed" | "failed";
  appliedPosts: number;
  appliedChat: number;
  pendingChunks: string[];
  error?: string;
}

export async function syncConnection(vault: UnlockedVault, connection: Connection, deps: SyncDeps): Promise<SyncResult> {
  const settings = await loadSettings(vault);
  if (!settings.authorId) throw new AppError("Choose a handle before syncing.");
  if (!connection.feedUrl) return { status: "no-feed", appliedPosts: 0, appliedChat: 0, pendingChunks: [] };
  if (!isValidFeedUrl(connection.feedUrl)) throw new AppError("That connection's feed URL must be an https URL (http is allowed only for localhost).");
  if (!connection.pubkey) throw new AppError("This connection has no verified key.");
  if (deps.network === "cellular" && !settings.syncOnCellular) {
    return { status: "deferred", appliedPosts: 0, appliedChat: 0, pendingChunks: [] };
  }

  // Pending chunks from a cellular-deferred pull must be retried: skip the etag shortcut and
  // re-apply the same manifest (chunk application is idempotent), so delivery does not depend
  // on the sender republishing.
  const head = await deps.fetch(manifestUrl(connection.feedUrl), connection.syncPending ? null : connection.syncEtag);
  if (head.status === 304) return { status: "unchanged", appliedPosts: 0, appliedChat: 0, pendingChunks: [] };
  if (head.status !== 200 || head.text === null) {
    throw new VaultCorruptError(`The feed could not be fetched (status ${head.status}).`);
  }
  const manifest = parseFeedManifest(head.text);
  await verifyFeedManifest(manifest, connection.id, connection.pubkey);
  // Same-key re-publish at a lower seq means the author restored older state (or rebuilt their
  // vault and re-shared the same identity). Chunk application is idempotent, so accept it as a
  // reset and continue from this seq instead of failing the connection forever. Authenticity is
  // unchanged: the manifest still has to verify against the connection's pinned key.
  
  if (manifest.seq === connection.syncSeq && !connection.syncPending) {
    await setConnectionSyncState(vault, connection.id, {
      seq: connection.syncSeq,
      etag: head.etag ?? connection.syncEtag,
      pending: connection.syncPending,
    });
    return { status: "unchanged", appliedPosts: 0, appliedChat: 0, pendingChunks: [] };
  }

  let appliedPosts = 0;
  let appliedChat = 0;
  const pendingChunks: string[] = [];
  for (const ref of manifest.chunks) {
    if (deps.network === "cellular" && ref.bytes > (deps.chunkBudgetBytes ?? CELLULAR_CHUNK_BUDGET_BYTES)) {
      pendingChunks.push(ref.id);
      continue;
    }
    const res = await deps.fetch(chunkUrl(connection.feedUrl, ref.id), null);
    if (res.status !== 200 || res.text === null) {
      throw new VaultCorruptError(`A feed chunk could not be fetched (status ${res.status}).`);
    }
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
  }

  await setConnectionSyncState(vault, connection.id, {
    seq: manifest.seq,
    etag: head.etag ?? connection.syncEtag,
    pending: pendingChunks.length > 0,
  });
  return {
    status: pendingChunks.length > 0 ? "deferred" : "applied",
    appliedPosts,
    appliedChat,
    pendingChunks,
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
      results.set(connection.id, {
        status: "failed",
        appliedPosts: 0,
        appliedChat: 0,
        pendingChunks: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
