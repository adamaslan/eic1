import {
  configureRelayFeed, createRelayTransport, listConnections, loadSettings, noteReceiptPublishFailure,
  publishRelaySnapshot, relayPublishReason, signedRelayFetcher, networkPolicy, syncConnection,
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

/** Automatic relay policy (see networkPolicy): Wi-Fi freely; unknown (Safari/iPhone) small encrypted data only; reported
 * cellular only when the owner opted in. Unknown is never treated as Wi-Fi. */
export const relayPolicy = networkPolicy;

/** One background pass for the unlocked vault: set up the feed if missing, retry any unaccepted send,
 * then pull every friend's feed. Each step is independent: one failure does not stop the others. */
export async function runRelayPass(vault: UnlockedVault, endpoint: string, now: () => Date = () => new Date()): Promise<{ sent: boolean; received: number; failed: number }> {
  const settings = await loadSettings(vault);
  const policy = relayPolicy(detectSyncNetwork(), settings.syncOnCellular);
  if (!policy.allowed) return { sent: false, received: 0, failed: 0 };
  let sent = false; let received = 0; let failed = 0;
  // Zero-setup feed: idempotent, never replaces a different feed URL.
  if (!settings.feedUrl && settings.authorId && settings.handle) await configureRelayFeed(vault, endpoint).catch(() => { failed += 1; });
  // A relay response is never delivery: only a confirmed signed readback counts as sent. A pending result is a
  // failure here, and receipt-only failures are counted so an unreachable relay cannot loop forever.
  const publish = async (reason: "messages" | "receipts"): Promise<boolean> => {
    try {
      const result = await publishRelaySnapshot(vault, createRelayTransport(endpoint), now, { maxBytes: policy.budgetBytes });
      if (result.status === "confirmed") { sent = true; return true; }
      // Over the byte budget on an unknown/cellular link: nothing was sent and nothing failed. It waits intact.
      if (result.status === "deferred") return false;
    } catch { /* counted below */ }
    failed += 1;
    if (reason === "receipts") await noteReceiptPublishFailure(vault);
    return false;
  };
  const before = await relayPublishReason(vault);
  const publishedBefore = before === null ? true : await publish(before);
  for (const connection of relayFeedConnections(await listConnections(vault), endpoint)) {
    try {
      const result = await syncConnection(vault, connection, { fetch: signedRelayFetcher(vault, endpoint), network: detectSyncNetwork(), newId: newItemId, now: now() });
      received += result.appliedChat;
    } catch { failed += 1; }
  }
  // Messages saved by this pull owe a receipt even if this person never replies. Publish it in the same pass
  // (a receipt is not a message, so it never creates a receipt of its own: no ping-pong).
  if (publishedBefore) {
    const after = await relayPublishReason(vault);
    if (after !== null) await publish(after);
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
