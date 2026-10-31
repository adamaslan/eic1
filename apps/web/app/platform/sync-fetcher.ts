import type { SyncFetchResponse, SyncFetcher, SyncNetwork } from "@veil/features";

/** Browser fetch adapter for the sync engine: conditional GET with etag, body as text. */
export const httpSyncFetcher: SyncFetcher = async (url: string, etag: string | null): Promise<SyncFetchResponse> => {
  const res = await fetch(url, { headers: etag ? { "If-None-Match": etag } : {} });
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    text: res.status === 304 ? null : await res.text(),
  };
};

/**
 * Real connectivity policy: wi-fi only by default. A metered/cellular connection (or an
 * unknown one) is reported as "cellular" so the sync engine applies its byte budget and
 * defers oversized chunks instead of pulling them unconditionally.
 */
export function detectSyncNetwork(): SyncNetwork {
  const conn = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string; saveData?: boolean } }).connection;
  if (!conn) return "cellular";
  if (conn.saveData) return "cellular";
  if (conn.type) return conn.type === "wifi" || conn.type === "ethernet" ? "wifi" : "cellular";
  if (conn.effectiveType) return conn.effectiveType === "4g" ? "wifi" : "cellular";
  return "cellular";
}
