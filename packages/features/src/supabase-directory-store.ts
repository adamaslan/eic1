import { AppError } from "@veil/core";
import type { DirectoryAtomicStore, DirectoryDatabase } from "./discover-directory";
import { emptyDirectory } from "./discover-directory";
import { RelayStoreUnavailableError, type RelayRpc } from "./supabase-relay-store";

/** SERVER ONLY, same injection rule as supabase-relay-store: the caller supplies a secret-backed client.
 * Whole-state compare-and-set on one row. Bounded and correct, NOT a throughput design; the matching SQL
 * is a LOCAL DRAFT (supabase/local-draft/hosted-directory.sql), not an applied migration. */
export function createSupabaseDirectoryStore(client: RelayRpc): DirectoryAtomicStore {
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result;
    try { result = await client.rpc(`eic_relay_${name}`, args); }
    catch { throw new RelayStoreUnavailableError("The encrypted relay store is unavailable."); }
    if (result.error) throw new RelayStoreUnavailableError("The encrypted relay store is unavailable.");
    return result.data;
  }
  return {
    async read() {
      const row = await call("directory_read", {}) as { generation?: unknown; value?: unknown } | null;
      if (row === null) return { generation: "0", value: emptyDirectory() };
      if (typeof row.generation !== "string" || typeof row.value !== "object" || row.value === null) throw new AppError("The directory state is damaged.");
      return { generation: row.generation, value: row.value as DirectoryDatabase };
    },
    async compareAndSet(generation, value) {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4 * 1024 * 1024) throw new AppError("The directory is full.");
      return (await call("directory_cas", { p_generation: generation, p_value: value })) === true;
    },
  };
}
