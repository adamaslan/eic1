import { AppError, encodeBase64 } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { publisherPath, type RelayPublishRequest } from "./chat-relay";
import { signRelayRead, type RelayReadRequest } from "./relay-adapter";
import { loadOrCreateShareIdentity } from "./sharing";
import { loadSettings, saveSettings } from "./social";
import type { SyncFetcher } from "./sync";

export function relayEndpoint(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new AppError("Invalid encrypted relay endpoint.");
  return url.href.replace(/\/+$/, "");
}

/** Fixed endpoint, bounded bodies and deadlines. No redirects or ambient cookies. */
export function createRelayTransport(endpoint: string, fetcher: typeof fetch = globalThis.fetch) {
  const base = relayEndpoint(endpoint);
  async function post(action: string, body: unknown): Promise<Record<string, unknown>> {
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).byteLength > 2 * 1024 * 1024) throw new AppError("The sealed backlog is too large for this relay.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(`${base}/${action}`, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json" }, body: encoded });
      if (!response.ok || !response.body) throw new AppError("Encrypted relay request failed. Your local messages are kept.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0; let text = "";
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new AppError("Relay response is too large."); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new AppError("Invalid relay response.");
      return data as Record<string, unknown>;
    } finally { clearTimeout(timeout); }
  }
  return {
    async publish(request: RelayPublishRequest): Promise<void> { await post("publish", request); },
    async read(request: RelayReadRequest): Promise<{ manifest: string }> { const result = await post("read", request); if (typeof result.manifest !== "string") throw new AppError("Invalid relay manifest."); return { manifest: result.manifest }; },
    async chunk(request: RelayReadRequest & { chunkId: string }): Promise<{ chunk: string }> { const result = await post("chunk", request); if (typeof result.chunk !== "string") throw new AppError("Invalid relay chunk."); return { chunk: result.chunk }; },
  };
}

/** Explicit user action only. Never replaces an existing different feed destination. */
export async function configureRelayFeed(vault: UnlockedVault, endpoint: string): Promise<{ publicKey: string; feedUrl: string }> {
  const base = relayEndpoint(endpoint);
  const identity = await loadOrCreateShareIdentity(vault);
  const publicKey = encodeBase64(identity.publicKey);
  const feedUrl = `${base}/${await publisherPath(publicKey)}`;
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle) throw new AppError("Choose your handle in Settings first.");
  if (settings.feedUrl && settings.feedUrl !== feedUrl) throw new AppError("This vault already has a different feed URL. It was not replaced.");
  await saveSettings(vault, { ...settings, feedUrl });
  return { publicKey, feedUrl };
}

/** Adapts the existing signed/hash-checked pull importer, not a second chat protocol. */
export function signedRelayFetcher(vault: UnlockedVault, endpoint: string, fetcher: typeof fetch = globalThis.fetch): SyncFetcher {
  const base = relayEndpoint(endpoint); const transport = createRelayTransport(base, fetcher);
  return async (url) => {
    if (!url.startsWith(`${base}/feeds/`)) throw new AppError("The connection is not on this encrypted relay.");
    const relative = url.slice(base.length + 1);
    const match = /^(feeds\/[a-z2-7]{52})\/(feed\.json|chunks\/(chat-[a-zA-Z0-9_-]{1,128}\.json))$/.exec(relative);
    if (!match) throw new AppError("Invalid encrypted relay feed path.");
    const identity = await loadOrCreateShareIdentity(vault);
    const pubkey = encodeBase64(identity.publicKey);
    const ts = Date.now(); const nonce = encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    const objectPath = match[3] ? `${match[1]}/chunks/${match[3]}` : match[1];
    const request = { pubkey, feedPath: match[1], ts, nonce, signature: await signRelayRead(identity.secretKey, { feedPath: objectPath, ts, nonce }) };
    const text = match[3] ? (await transport.chunk({ ...request, chunkId: match[3] })).chunk : (await transport.read(request)).manifest;
    return { status: 200, etag: null, text };
  };
}
