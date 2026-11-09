import { AppError } from "@veil/core";
import type { RelayAtomicStore, StoreEntry, ListPage } from "./relay-adapter";

/** SERVER ONLY: inject an Edge Function's secret-backed client, never a browser client.
 * No client is constructed, secrets read, network called, or feature enabled by importing this file.
 * The matching SQL is a LOCAL DRAFT, not an applied migration or a deployed service.
 */
export interface RelayRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export class RelayStoreUnavailableError extends AppError {}

export function createSupabaseRelayStore(client: RelayRpc): RelayAtomicStore {
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result;
    try { result = await client.rpc(`eic_relay_${name}`, args); }
    catch { throw new RelayStoreUnavailableError("The encrypted relay store is unavailable."); }
    // Never expose database error details, connection strings or secrets to a caller.
    if (result.error) throw new RelayStoreUnavailableError("The encrypted relay store is unavailable.");
    return result.data;
  }
  function path(value: string): string {
    if (!value || new TextEncoder().encode(value).byteLength > 1024 || /[\u0000-\u001f]/.test(value)) throw new AppError("Invalid relay store path.");
    return value;
  }
  function text(value: string): string {
    if (new TextEncoder().encode(value).byteLength > 1_100_000) throw new AppError("Relay object is too large.");
    return value;
  }
  return {
    async get(key): Promise<StoreEntry | null> {
      const data = await call("get", { p_key: path(key) });
      if (data === null) return null;
      if (typeof data !== "object" || !data || !("data" in data) || !("generation" in data) || typeof data.data !== "string" || typeof data.generation !== "string") throw new RelayStoreUnavailableError("Invalid relay store response.");
      return { data: data.data, generation: data.generation };
    },
    async compareAndSet(key, data, condition) {
      const expected = "createOnly" in condition ? null : condition.generation;
      if (expected !== null && !/^[1-9][0-9]*$/.test(expected)) throw new AppError("Invalid relay generation.");
      const result = await call("cas", { p_key: path(key), p_data: text(data), p_expected: expected });
      if (result !== null && (typeof result !== "string" || !/^[1-9][0-9]*$/.test(result))) throw new RelayStoreUnavailableError("Invalid relay store response.");
      return result as string | null;
    },
    async putObject(key, data) { await call("put", { p_key: path(key), p_data: text(data) }); },
    async list(prefix, opts): Promise<ListPage> {
      const limit = opts?.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AppError("Invalid relay list limit.");
      const data = await call("list", { p_prefix: path(prefix), p_cursor: opts?.cursor ? path(opts.cursor) : null, p_limit: limit });
      if (typeof data !== "object" || !data || !("keys" in data) || !Array.isArray(data.keys) || data.keys.length > limit || !data.keys.every(k => typeof k === "string" && k.startsWith(prefix))) throw new RelayStoreUnavailableError("Invalid relay store response.");
      const cursor = "nextCursor" in data ? data.nextCursor : undefined;
      if (cursor !== undefined && (typeof cursor !== "string" || !data.keys.includes(cursor))) throw new RelayStoreUnavailableError("Invalid relay store response.");
      return { keys: data.keys, ...(cursor ? { nextCursor: cursor as string } : {}) };
    },
    async delete(key) { await call("delete", { p_key: path(key) }); },
  };
}
