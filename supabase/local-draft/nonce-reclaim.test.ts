import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createSupabaseRelayStore, type RelayRpc } from "../../packages/features/src/supabase-relay-store";

// Local PGlite proof for nonce reclamation. Same harness contract as hosted-schema.test.ts:
// PGlite is in-process Postgres, not hosted Supabase or multi-session concurrency evidence.
const modulePath = process.env.EIC_PGLITE_MODULE;
if (!modulePath?.startsWith("/")) throw new Error("Set EIC_PGLITE_MODULE to an absolute local PGlite module path.");
const { PGlite } = await import(/* @vite-ignore */ modulePath);
const db = new PGlite();
const functions: Record<string, string[]> = {
  eic_relay_get: ["p_key"], eic_relay_cas: ["p_key", "p_data", "p_expected"],
  eic_relay_put: ["p_key", "p_data"], eic_relay_list: ["p_prefix", "p_cursor", "p_limit"], eic_relay_delete: ["p_key"],
};
const client: RelayRpc = { async rpc(name, args) {
  const keys = functions[name]; if (!keys) throw new Error("Unexpected function");
  try {
    const { rows } = await db.query(`select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(",")}) as value`, keys.map(k => args[k]));
    return { data: rows[0].value, error: null };
  } catch (error) { return { data: null, error }; }
} };
const store = createSupabaseRelayStore(client);

const READER = (c: string) => c.repeat(52);
// Inserts nonce rows directly, with updated_at far in the past so the one-minute
// rate window does not fire. `data` is the signed read timestamp in ms.
// The capacity trigger is disabled only for this seeding statement (it is O(n) per row),
// then re-enabled, so the enforcement under test is the real trigger.
async function seedNonces(reader: string, count: number, dataMs: string) {
  await db.exec(`alter table eic_relay.objects disable trigger relay_capacity;
    insert into eic_relay.objects(key,data,updated_at)
    select 'replay/${reader}/item/' || i, '${dataMs}', now() - interval '1 hour'
    from generate_series(1, ${count}) as i;
    alter table eic_relay.objects enable trigger relay_capacity;`);
}

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(await readFile("supabase/local-draft/hosted-relay.sql", "utf8"));
});
afterAll(async () => { await db.close(); });

describe("nonce reclamation (local PGlite, not hosted)", () => {
  it("a reader whose nonces are all expired can still read", async () => {
    await db.exec("begin");
    try {
      const expired = String(Date.now() - 60 * 60 * 1000);
      await seedNonces(READER("a"), 1200, expired);
      const fresh = await store.compareAndSet(`replay/${READER("a")}/feeds%2Fx/nonce-new`, String(Date.now()), { createOnly: true });
      expect(fresh).not.toBeNull();
    } finally { await db.exec("rollback"); }
  });

  it("a full relay with only expired nonces still accepts a new write", async () => {
    await db.exec("begin");
    try {
      const expired = String(Date.now() - 60 * 60 * 1000);
      for (const c of ["a", "b", "c", "d", "e", "f", "g", "h"]) await seedNonces(READER(c), 1200, expired);
      await seedNonces(READER("i"), 400, expired); // 10000 rows total: row cap reached
      await expect(store.putObject("feeds/x/objects/1/chunks/chat-y.json", "{}")).resolves.toBeUndefined();
    } finally { await db.exec("rollback"); }
  });

  it("fresh nonces are not reclaimed: a reader at its cap still gets refused", async () => {
    await db.exec("begin");
    try {
      await seedNonces(READER("j"), 1200, String(Date.now()));
      await db.exec("savepoint cap");
      await expect(store.compareAndSet(`replay/${READER("j")}/feeds%2Fx/nonce-new`, String(Date.now()), { createOnly: true })).rejects.toThrow();
      await db.exec("rollback to savepoint cap");
    } finally { await db.exec("rollback"); }
  });
});
