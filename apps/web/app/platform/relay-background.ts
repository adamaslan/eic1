import {
  configureRelayFeed, createRelayTransport, hasUnacceptedOutbound, listConnections, loadSettings,
  publishRelaySnapshot, signedRelayFetcher, syncConnection, type SyncNetwork,
} from "@veil/features";
import type { UnlockedVault } from "@veil/vault";

type Connection = Awaited<ReturnType<typeof listConnections>>[number];
import { detectSyncNetwork } from "~/platform/sync-fetcher";
import { newItemId } from "~/platform/vault-service";
import { startForegroundRelay } from "~/platform/foreground-relay";

/** Connections whose feed lives on this relay. Others (legacy file feeds) are never fetched here. */
export function relayFeedConnections(connections: Connection[], endpoint: string): Connection[] {
  return connections.filter((c) => c.pubkey && c.feedUrl && c.feedUrl.startsWith(`${endpoint}/feeds/`));
}

/** Wi-Fi by default; cellular only when the owner turned on cellular sync. */
export function relayAllowed(network: SyncNetwork, syncOnCellular: boolean): boolean {
  return network === "wifi" || syncOnCellular;
}

/** One background pass for the unlocked vault: set up the feed if missing, retry any unaccepted send,
 * then pull every friend's feed. Each step is independent: one failure does not stop the others. */
export async function runRelayPass(vault: UnlockedVault, endpoint: string, now: () => Date = () => new Date()): Promise<{ sent: boolean; received: number; failed: number }> {
  const settings = await loadSettings(vault);
  if (!relayAllowed(detectSyncNetwork(), settings.syncOnCellular)) return { sent: false, received: 0, failed: 0 };
  let sent = false; let received = 0; let failed = 0;
  // Zero-setup feed: idempotent, never replaces a different feed URL.
  if (!settings.feedUrl && settings.authorId && settings.handle) await configureRelayFeed(vault, endpoint).catch(() => { failed += 1; });
  if (await hasUnacceptedOutbound(vault)) {
    try { await publishRelaySnapshot(vault, createRelayTransport(endpoint), now); sent = true; } catch { failed += 1; }
  }
  for (const connection of relayFeedConnections(await listConnections(vault), endpoint)) {
    try {
      const result = await syncConnection(vault, connection, { fetch: signedRelayFetcher(vault, endpoint), network: detectSyncNetwork(), newId: newItemId, now: now() });
      received += result.appliedChat;
    } catch { failed += 1; }
  }
  return { sent, received, failed };
}

/** Visible, online, unlocked only. Never runs after lock. Minimum one minute between passes (see foreground-relay). */
export function startRelayBackground(options: { vault: UnlockedVault; endpoint: string; isCurrent: () => boolean; onPass?: (result: { sent: boolean; received: number; failed: number }) => void }) {
  return startForegroundRelay({
    active: () => options.isCurrent() && document.visibilityState === "visible" && navigator.onLine,
    subscribe: (wake) => {
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      return () => {
        document.removeEventListener("visibilitychange", wake);
        window.removeEventListener("online", wake);
        window.removeEventListener("focus", wake);
      };
    },
    run: async () => {
      if (!options.isCurrent()) return;
      const result = await runRelayPass(options.vault, options.endpoint);
      options.onPass?.(result);
    },
  });
}
