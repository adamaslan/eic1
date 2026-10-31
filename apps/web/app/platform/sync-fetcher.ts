import type { SyncFetchResponse, SyncFetcher } from "@veil/features";

/** Browser fetch adapter for the sync engine: conditional GET with etag, body as text. */
export const httpSyncFetcher: SyncFetcher = async (url: string, etag: string | null): Promise<SyncFetchResponse> => {
  const res = await fetch(url, { headers: etag ? { "If-None-Match": etag } : {} });
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    text: res.status === 304 ? null : await res.text(),
  };
};
