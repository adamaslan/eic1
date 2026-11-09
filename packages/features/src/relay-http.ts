import { AppError } from "@veil/core";
import { RelayStoreUnavailableError } from "./supabase-relay-store";
import { RelayRateLimitError, admitRelayPublish, serveRelayRead, serveRelayChunk, type RelayAtomicStore, type RelayReadRequest } from "./relay-adapter";
import type { RelayPublishRequest } from "./chat-relay";

export const RELAY_HTTP_MAX_BYTES = 2 * 1024 * 1024;
export interface RelayHttpOptions {
  /** Default is OFF. This local-only factory is not a deployment or activation path. */
  enabled?: boolean;
  origins: string[];
  keys: string[];
  maxPublishesPerWindow: number;
  windowMs: number;
  now: () => Date;
}

class BadRequest extends Error {}
async function boundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > RELAY_HTTP_MAX_BYTES)) throw new BadRequest();
  if (!request.body) throw new BadRequest();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0; let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RELAY_HTTP_MAX_BYTES) { await reader.cancel(); throw new BadRequest(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { throw new BadRequest(); } finally { reader.releaseLock(); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRead(value: unknown): value is RelayReadRequest & { chunkId?: string } {
  return record(value) && typeof value.pubkey === "string" && value.pubkey.length <= 128
    && typeof value.signature === "string" && value.signature.length <= 128
    && typeof value.feedPath === "string" && value.feedPath.length <= 256
    && typeof value.ts === "number" && Number.isFinite(value.ts)
    && typeof value.nonce === "string" && value.nonce.length > 0 && value.nonce.length <= 128
    && (value.chunkId === undefined || typeof value.chunkId === "string");
}

/** Host-neutral, no listener/env/SDK/client construction. Caller supplies server-only store.
 * CORS is defense in depth, NOT authentication. Every operation still uses signed core gates.
 * No key in a nonempty configured allowlist means no access. No anonymous open enrollment.
 */
export function createRelayHttpHandler(store: RelayAtomicStore, options: RelayHttpOptions): (request: Request) => Promise<Response> {
  // Snapshot caller configuration so mutation cannot open the gateway after construction.
  const enabled = options.enabled === true;
  const origins = new Set(options.origins);
  const keys = [...options.keys];
  const rate = options.maxPublishesPerWindow; const windowMs = options.windowMs;
  const configured = keys.length > 0 && keys.every(key => typeof key === "string" && key.length > 0 && key.length <= 128)
    && Number.isInteger(rate) && rate > 0 && rate <= 100 && Number.isInteger(windowMs) && windowMs >= 1000;
  return async request => {
    const origin = request.headers.get("origin");
    const allowedOrigin = origin !== null && origins.has(origin);
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "vary": "Origin" };
    if (allowedOrigin) headers["access-control-allow-origin"] = origin;
    const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
    if (!enabled || !configured) return reply(503, { error: "Encrypted relay is disabled." });
    if (origin !== null && !allowedOrigin) return reply(403, { error: "Request denied." });
    const action = new URL(request.url).pathname.split("/").pop();
    if (!["publish", "read", "chunk"].includes(action ?? "")) return reply(404, { error: "Not found." });
    if (request.method === "OPTIONS") {
      if (!allowedOrigin || request.headers.get("access-control-request-method") !== "POST") return reply(403, { error: "Request denied." });
      return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
    }
    if (request.method !== "POST") return reply(405, { error: "Use POST." });
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(415, { error: "JSON required." });
    try {
      const body = await boundedJson(request);
      if (action === "publish") {
        if (!record(body) || typeof body.manifest !== "string" || !Array.isArray(body.files)) throw new BadRequest();
        // Core verifies exact manifest/file hashes and Ed25519 signature before any store call.
        const result = await admitRelayPublish(store, body as unknown as RelayPublishRequest, { allowlist: keys, maxPublishesPerWindow: rate, windowMs, now: options.now() });
        return reply(200, { publisherPath: result.publisherPath });
      }
      if (!isRead(body)) throw new BadRequest();
      if (action === "chunk") {
        if (typeof body.chunkId !== "string") throw new BadRequest();
        const { chunk } = await serveRelayChunk(store, { ...body, chunkId: body.chunkId }, { allowlist: keys, now: options.now() });
        return reply(200, { chunk });
      }
      const { manifest } = await serveRelayRead(store, body, { allowlist: keys, now: options.now() });
      return reply(200, { manifest });
    } catch (error) {
      // Backend details and signed request material never leave the gateway.
      if (error instanceof RelayRateLimitError) return reply(429, { error: "Relay rate limit reached. Keep your local message and try later." });
      if (error instanceof BadRequest || (error instanceof AppError && !(error instanceof RelayStoreUnavailableError))) {
        return reply(400, { error: "Relay request rejected. Keep your local message." });
      }
      return reply(503, { error: "Encrypted relay is unavailable. Keep your local message and try later." });
    }
  };
}
