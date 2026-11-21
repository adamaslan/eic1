import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

// Self-enroll + directory SQL on real in-process Postgres (PGlite is NOT hosted Supabase).
const modulePath = process.env.EIC_PGLITE_MODULE;
if (!modulePath?.startsWith("/")) throw new Error("Set EIC_PGLITE_MODULE to an absolute local PGlite module path.");
const { PGlite } = await import(/* @vite-ignore */ modulePath);
const db = new PGlite();

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  for (const file of ["hosted-relay.sql", "hosted-relay-v2-members.sql", "hosted-directory.sql", "hosted-self-enroll.sql", "hosted-relay-v3-admission.sql"]) {
    await db.exec(await readFile(`supabase/local-draft/${file}`, "utf8"));
  }
  await db.query("update eic_relay.config set enabled=true, public_keys=$1, origins=$2", [["root-key"], ["https://eic.example"]]);
}, 180000);
afterAll(async () => { await db.close?.(); });

const admit = async (pubkey: string) => (await db.query("select public.eic_relay_admit_self($1) as value", [pubkey])).rows[0] as { value: string };
const claim = async (limit: number) => (await db.query("select public.eic_relay_claim_self_enroll($1) as value", [limit])).rows[0] as { value: boolean };

describe("eic_relay_admit_self", () => {
  it("enrolls a new key once, then reports member", async () => {
    expect((await admit("new-key-1")).value).toBe("enrolled");
    expect((await admit("new-key-1")).value).toBe("member");
  });
  it("treats a manual-override root key as a member without inserting", async () => {
    expect((await admit("root-key")).value).toBe("member");
    const { rows } = await db.query("select count(*)::int as n from eic_relay.members where pubkey = 'root-key'");
    expect((rows[0] as { n: number }).n).toBe(0);
  });
  it("refuses new keys at the member cap", async () => {
    const { rows } = await db.query("select count(*)::int as n from eic_relay.members");
    const current = (rows[0] as { n: number }).n;
    const original = (await db.query("select max_members from eic_relay.config")).rows[0] as { max_members: number };
    await db.query("update eic_relay.config set max_members = $1", [current]);
    try { expect((await admit("new-key-over-cap")).value).toBe("capacity"); }
    finally { await db.query("update eic_relay.config set max_members = $1", [original.max_members]); }
  });
});

describe("self-enrolled members cannot vouch (v3)", () => {
  it("a self-enrolled key cannot invite, but a root can", async () => {
    await admit("self-voucher");
    const invite = "invite-0000000000000001";
    const vouch = async (inviter: string) => (await db.query("select public.eic_relay_enroll($1, $2, $3) as value", ["invitee-" + inviter, inviter, invite])).rows[0] as { value: string };
    expect((await vouch("self-voucher")).value).toBe("inviter_quota");
    expect((await vouch("root-key")).value).toBe("enrolled");
  });
});

describe("eic_relay_claim_self_enroll", () => {
  // Own the counter: start each case from an empty day so the budget never depends on test order.
  beforeEach(async () => { await db.exec("delete from eic_relay.self_enroll_daily"); });
  it("stops at the daily limit", async () => {
    expect((await claim(2)).value).toBe(true);
    expect((await claim(2)).value).toBe(true);
    expect((await claim(2)).value).toBe(false);
  });
  it("a zero budget disables self-enrollment in the database", async () => {
    expect((await claim(0)).value).toBe(false);
  });
});

describe("directory state compare-and-set", () => {
  const read = async () => (await db.query("select public.eic_relay_directory_read() as value")).rows[0] as { value: { generation: string; value: unknown } | null };
  const cas = async (generation: string, value: unknown) =>
    (await db.query("select public.eic_relay_directory_cas($1, $2::jsonb) as value", [generation, JSON.stringify(value)])).rows[0] as { value: boolean };

  it("starts at generation 0 with an empty directory", async () => {
    const row = (await read()).value!;
    expect(row.generation).toBe("0");
    expect(row.value).toEqual({ cards: {}, requests: {}, actors: {} });
  });
  it("writes only against the current generation", async () => {
    expect((await cas("0", { cards: { a: {} }, requests: {}, actors: {} })).value).toBe(true);
    expect((await cas("0", { cards: {}, requests: {}, actors: {} })).value).toBe(false);
    expect((await read()).value!.generation).toBe("1");
  });
  it("refuses an oversized directory", async () => {
    const big = { blob: "x".repeat(4194400) };
    await expect(cas("1", big)).rejects.toThrow("Directory is full");
  });
});
