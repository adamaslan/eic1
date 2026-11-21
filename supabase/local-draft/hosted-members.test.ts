import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import { encodeBase64 } from "@veil/core";
import { createSupabaseRelayMembership, createSupabaseRelayStore, type RelayRpc } from "../../packages/features/src/supabase-relay-store";
import { createRelayHttpHandler } from "../../packages/features/src/relay-http";
import { signRelayEnroll, signRelayInvite } from "../../packages/features/src/relay-enroll";

// v2 migration (vouched enrollment + per-publisher cap) on real in-process Postgres.
// PGlite is NOT hosted Supabase, multi-session concurrency or deployed RLS proof.
const modulePath = process.env.EIC_PGLITE_MODULE;
if (!modulePath?.startsWith("/")) throw new Error("Set EIC_PGLITE_MODULE to an absolute local PGlite module path.");
const { PGlite } = await import(/* @vite-ignore */ modulePath);
const db = new PGlite();
const functions: Record<string, string[]> = {
  eic_relay_get: ["p_key"], eic_relay_cas: ["p_key", "p_data", "p_expected"], eic_relay_put: ["p_key", "p_data"],
  eic_relay_list: ["p_prefix", "p_cursor", "p_limit"], eic_relay_delete: ["p_key"],
  eic_relay_is_member: ["p_pubkey"], eic_relay_enroll: ["p_pubkey", "p_inviter", "p_invite_id"],
};
const client: RelayRpc = { async rpc(name, args) {
  const keys = functions[name]; if (!keys) throw new Error("Unexpected function");
  try {
    const { rows } = await db.query(`select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(",")}) as value`, keys.map(k => args[k]));
    return { data: rows[0].value, error: null };
  } catch (error) { return { data: null, error }; }
} };
const store = createSupabaseRelayStore(client);
const membership = createSupabaseRelayMembership(client);
const pub = (k: { publicKey: Uint8Array }) => encodeBase64(k.publicKey);
const id = (n: number) => `invite-${String(n).padStart(10, "0")}`;
let root: Awaited<ReturnType<typeof generateSigningKeyPair>>;
let legacy: string;

beforeAll(async () => {
  root = await generateSigningKeyPair();
  legacy = pub(await generateSigningKeyPair());
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(await readFile("supabase/local-draft/hosted-relay.sql", "utf8"));
  // Mirrors hosted state: keys admitted by hand before v2 must survive as roots.
  await db.query("update eic_relay.config set enabled=true, public_keys=$1, origins=$2", [[pub(root), legacy], ["https://eic.example"]]);
  await db.exec(await readFile("supabase/local-draft/hosted-relay-v2-members.sql", "utf8"));
});
afterAll(async () => { await db.close(); });

describe("v2 members migration", () => {
  it("seeds existing public_keys as roots and keeps config.public_keys as a manual override", async () => {
    expect((await db.query("select pubkey, inviter from eic_relay.members order by pubkey")).rows).toHaveLength(2);
    expect(await membership.isMember(legacy)).toBe(true);
    const override = pub(await generateSigningKeyPair());
    expect(await membership.isMember(override)).toBe(false);
    await db.query("update eic_relay.config set public_keys = array_append(public_keys, $1)", [override]);
    expect(await membership.isMember(override)).toBe(true);
    await db.query("update eic_relay.config set public_keys = array_remove(public_keys, $1)", [override]);
  });

  it("is server-only: browser roles cannot call the RPCs or read members", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select public.eic_relay_is_member('x')")).rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.eic_relay_enroll('x','y','${id(0)}')`)).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from eic_relay.members")).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });

  it("enrolls through a member, is idempotent, and denies strangers", async () => {
    const a = pub(await generateSigningKeyPair()), stranger = pub(await generateSigningKeyPair());
    expect(await membership.enroll({ pubkey: a, inviterPub: pub(root), inviteId: id(1) })).toBe("enrolled");
    expect(await membership.enroll({ pubkey: a, inviterPub: pub(root), inviteId: id(1) })).toBe("member");
    expect(await membership.enroll({ pubkey: pub(await generateSigningKeyPair()), inviterPub: stranger, inviteId: id(2) })).toBe("inviter_not_member");
    await expect(db.query("select public.eic_relay_enroll('x','y','bad id')")).rejects.toThrow(/Invalid enrollment/);
  });

  it("enforces uses per invite, vouches per member and the member cap from config", async () => {
    await db.exec("begin");
    try {
      await db.exec("update eic_relay.config set uses_per_invite=2, invites_per_member=3");
      const fresh = async () => pub(await generateSigningKeyPair());
      const inviter = await fresh();
      expect(await membership.enroll({ pubkey: inviter, inviterPub: pub(root), inviteId: id(3) })).toBe("enrolled");
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: inviter, inviteId: id(4) })).toBe("enrolled");
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: inviter, inviteId: id(4) })).toBe("enrolled");
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: inviter, inviteId: id(4) })).toBe("invite_used");
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: inviter, inviteId: id(5) })).toBe("enrolled");
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: inviter, inviteId: id(6) })).toBe("inviter_quota");
      const count = Number((await db.query("select count(*) as n from eic_relay.members")).rows[0].n);
      await db.query("update eic_relay.config set max_members=$1", [count]);
      expect(await membership.enroll({ pubkey: await fresh(), inviterPub: pub(root), inviteId: id(7) })).toBe("capacity");
    } finally { await db.exec("rollback"); }
  });

  it("caps one publisher's feed rows and bytes without blocking in-place state updates", async () => {
    await db.exec("begin");
    try {
      await db.exec("update eic_relay.config set feed_max_rows=3, feed_max_bytes=4096");
      const feed = `feeds/${"a".repeat(52)}`;
      expect(await store.compareAndSet(`${feed}/.state.json`, "{}", { createOnly: true })).not.toBeNull();
      await store.putObject(`${feed}/objects/1/feed.json`, "x");
      await store.putObject(`${feed}/objects/1/chunks/chat-a.json`, "x");
      await db.exec("savepoint over_rows");
      await expect(store.putObject(`${feed}/objects/2/feed.json`, "x")).rejects.toThrow();
      await db.exec("rollback to savepoint over_rows");
      const state = await store.get(`${feed}/.state.json`);
      expect(await store.compareAndSet(`${feed}/.state.json`, "{\"committed\":true}", { generation: state!.generation })).not.toBeNull();
      // Another publisher is unaffected.
      await store.putObject(`feeds/${"b".repeat(52)}/objects/1/feed.json`, "x");
      await db.exec("savepoint over_bytes");
      await expect(store.putObject(`feeds/${"b".repeat(52)}/objects/1/chunks/chat-big.json`, "x".repeat(5000))).rejects.toThrow();
      await db.exec("rollback to savepoint over_bytes");
      await db.exec("savepoint bad_ns");
      await expect(store.putObject("feeds/not-a-hash/feed.json", "x")).rejects.toThrow();
      await db.exec("rollback to savepoint bad_ns");
    } finally { await db.exec("rollback"); }
  });

  it("a fresh vault key enrolls over HTTP with a root's invite, then publishes; a replay is refused", async () => {
    const now = new Date();
    const friend = await generateSigningKeyPair();
    const handle = createRelayHttpHandler(store, { enabled: true, origins: ["https://eic.example"], membership, maxPublishesPerWindow: 5, windowMs: 60000, now: () => now });
    const post = (action: string, body: unknown) => handle(new Request(`https://local.invalid/${action}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://eic.example" }, body: JSON.stringify(body) }));
    const unsigned = { format: "eic-feed", version: 1, authorId: "fixture", feedUrl: "https://relay.example/feeds/x", pubkey: pub(friend), seq: 1, builtAt: now.toISOString(), chunks: [] };
    const manifest = JSON.stringify({ ...unsigned, signature: encodeBase64(await signPayload(friend.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)))) });
    const publish = { manifest, files: [{ path: "feed.json", text: manifest }] };
    expect((await post("publish", publish)).status).toBe(400);
    const enroll = await signRelayEnroll(friend, await signRelayInvite(root, now), now);
    expect((await post("enroll", enroll)).status).toBe(200);
    expect((await post("enroll", enroll)).status).toBe(400);
    expect((await post("publish", publish)).status).toBe(200);
  });
});
