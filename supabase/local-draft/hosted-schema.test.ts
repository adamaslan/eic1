import { prepareRelayOutbox, attemptRelayOutbox } from "../../packages/features/src/relay-outbox";
import { createRelayHttpHandler } from "../../packages/features/src/relay-http";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createSupabaseRelayStore, type RelayRpc } from "../../packages/features/src/supabase-relay-store";
import { admitRelayPublish, serveRelayRead, signRelayRead, sweepExpiredNonces } from "../../packages/features/src/relay-adapter";
import { generateSigningKeyPair, signPayload, SubtleCryptoPort } from "@veil/crypto";
import { encodeBase64 } from "@veil/core";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../packages/vault/src/memory-store";
import { defaultSettings, saveSettings, listConnections } from "../../packages/features/src/social";
import { buildShareBundle, importShareBundle, loadOrCreateShareIdentity } from "../../packages/features/src/sharing";
import { sendChatMessage, applyInboundChatEnvelope, listChatThread } from "../../packages/features/src/chat";
import { buildChatFeedSnapshot } from "../../packages/features/src/chat-relay";

// Deliberately separate from ordinary CI. Requires an explicitly installed local PGlite module.
// PGlite is real in-process Postgres, NOT hosted Supabase, multi-session concurrency or RLS deployment proof.
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
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(await readFile("supabase/local-draft/hosted-relay.sql", "utf8"));
});
afterAll(async () => { await db.close(); });
describe("actual local Postgres relay draft", () => {
  it("starts disabled and denies browser access to configuration", async () => {
    const config = await db.query("select public.eic_relay_config() as config");
    expect(config.rows[0].config).toEqual({enabled:false,keys:[],origins:[]});
    await db.exec("set role anon");
    await expect(db.query("select public.eic_relay_config()")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  });
  it("caps signed-reader nonce admission and preserves existing rows", async () => {
    await db.exec("begin");
    for(let i=0;i<120;i++) await store.compareAndSet(`replay/${"a".repeat(52)}/item/${i}`,"1",{createOnly:true});
    await db.exec("savepoint denial");
    await expect(store.compareAndSet(`replay/${"a".repeat(52)}/item/120`,"1",{createOnly:true})).rejects.toThrow();
    await db.exec("rollback to savepoint denial");
    expect(await store.compareAndSet(`replay/${"a".repeat(52)}/item/1`,"1",{createOnly:true})).toBeNull();
    await db.exec("rollback");
  });
  it("separates reader budgets and rejects slash-bearing digest namespaces", async () => {
    await db.exec("begin");
    try {
      for(let i=0;i<120;i++) await store.compareAndSet(`replay/${"b".repeat(52)}/item/${i}`,"1",{createOnly:true});
      expect(await store.compareAndSet(`replay/${"c".repeat(52)}/item/0`,"1",{createOnly:true})).not.toBeNull();
      await db.exec("savepoint invalid_namespace");
      await expect(store.compareAndSet("replay//reader-A-rest/item/0","1",{createOnly:true})).rejects.toThrow();
      await db.exec("rollback to savepoint invalid_namespace");
    } finally { await db.exec("rollback"); }
  });
  it("enforces total byte bound in database and never overwrites at full capacity", async () => {
    await db.exec("begin");
    try {
      for(let i=0;i<30;i++) await store.putObject(`capacity/${i}`,"x".repeat(1090000));
      await db.exec("savepoint denial");
      await expect(store.putObject("capacity/overflow","x".repeat(1090000))).rejects.toThrow();
      await db.exec("rollback to savepoint denial");
      expect((await store.get("capacity/0"))?.data.length).toBe(1090000);
    } finally {await db.exec("rollback");}
  });
  it("CAS has one winner, stale guards fail, delete/recreate cannot reuse old generation", async () => {
    const result = await Promise.all([store.compareAndSet("race", "one", { createOnly: true }), store.compareAndSet("race", "two", { createOnly: true })]);
    expect(result.filter(x => x !== null)).toHaveLength(1);
    const old = result.find(x => x !== null)!;
    const next = await store.compareAndSet("race", "three", { generation: old }); expect(next).not.toBeNull();
    expect(await store.compareAndSet("race", "stale", { generation: old })).toBeNull();
    await store.delete("race"); const recreated = await store.compareAndSet("race", "new", { createOnly: true });
    expect(recreated).not.toBe(old); expect(recreated).not.toBe(next);
    expect(await store.compareAndSet("race", "bad", { generation: next! })).toBeNull();
  });
  it("immutable put allows exact retry but rejects changed bytes", async () => {
    await store.putObject("immutable", "sealed"); await store.putObject("immutable", "sealed");
    await expect(store.putObject("immutable", "changed")).rejects.toThrow("unavailable");
    expect((await store.get("immutable"))?.data).toBe("sealed");
  });
  it("literal prefix and deleted cursor preserve bounded pagination", async () => {
    for (const key of ["p_/1", "p_/2", "p_/3", "px/1"]) await store.putObject(key, "x");
    const first = await store.list("p_/", { limit: 2 }); expect(first).toEqual({ keys: ["p_/1", "p_/2"], nextCursor: "p_/2" });
    await store.delete("p_/2"); expect(await store.list("p_/", { limit: 2, cursor: first.nextCursor })).toEqual({ keys: ["p_/3"] });
  });
  it("anon/authenticated cannot execute RPC or access table, service_role can call RPC", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select public.eic_relay_get('immutable')")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from eic_relay.objects")).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role"); expect((await store.get("immutable"))?.data).toBe("sealed"); await db.exec("reset role");
    expect((await db.query("select relrowsecurity from pg_class where oid='eic_relay.objects'::regclass")).rows[0].relrowsecurity).toBe(true);
  });
  it("existing signed relay publishes/reads through actual SQL adapter and blocks replay/tampering", async () => {
    const key = await generateSigningKeyPair(); const pubkey = encodeBase64(key.publicKey);
    const chunk = JSON.stringify({ format: "eic-feed-chunk", version: 1, kind: "chat", envelopes: [] });
    const hash = encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chunk))));
    const now = new Date("2026-11-06T20:00:00Z");
    const unsigned = { format: "eic-feed", version: 1, authorId: "local-fixture", feedUrl: "https://relay.example/feeds/fixture", pubkey, seq: 1, builtAt: now.toISOString(), chunks: [{ id: "chat-peer.json", kind: "chat", bytes: new TextEncoder().encode(chunk).byteLength, sha256: hash }] };
    const signature = encodeBase64(await signPayload(key.secretKey, new TextEncoder().encode(JSON.stringify(unsigned))));
    const manifest = JSON.stringify({ ...unsigned, signature });
    const request = { manifest, files: [{ path: "feed.json", text: manifest }, { path: "chunks/chat-peer.json", text: chunk }] };
    const admitted = await admitRelayPublish(store, request, { allowlist: [pubkey], maxPublishesPerWindow: 5, windowMs: 60000, now });
    const read = { pubkey, feedPath: admitted.publisherPath, ts: now.getTime(), nonce: "local-only-proof", signature: await signRelayRead(key.secretKey, { feedPath: admitted.publisherPath, ts: now.getTime(), nonce: "local-only-proof" }) };
    expect((await serveRelayRead(store, read, { allowlist: [pubkey], now })).manifest).toBe(manifest);
    await expect(serveRelayRead(store, read, { allowlist: [pubkey], now })).rejects.toThrow();
    await expect(admitRelayPublish(store, { ...request, manifest: manifest.replace("local-fixture", "tampered") }, { maxPublishesPerWindow: 5, windowMs: 60000, now })).rejects.toThrow();
    expect((await sweepExpiredNonces(store, new Date(now.getTime() + 600001))).deleted).toBe(1);
  });
  it("sealed chat crosses HTTP and real SQL into a second local vault without storing plaintext", async () => {
    const now = new Date("2026-11-06T20:01:00Z"); let n = 0;
    const deps = { newId: () => `proof-${n++}`, now: () => now };
    const make = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => now }, "local-proof-only-passphrase");
    const alice = await make(); const bob = await make();
    const a = { ...defaultSettings(), authorId: "alice-id", handle: "alice", feedUrl: "https://relay.example/feeds/alice" };
    const b = { ...defaultSettings(), authorId: "bob-id", handle: "bob" };
    await saveSettings(alice, a); await saveSettings(bob, b);
    await importShareBundle(bob, (await buildShareBundle(alice, a, [], now)).text, { settings: b, newId: deps.newId, now });
    await importShareBundle(alice, (await buildShareBundle(bob, b, [], now)).text, { settings: a, newId: deps.newId, now });
    const peer = (await listConnections(alice)).find(c => c.id === "bob-id")!;
    const plaintext = "Local sealed delivery proof, never send to hosted services";
    await sendChatMessage(alice, peer, plaintext, deps);
    const snapshot = await buildChatFeedSnapshot(alice, a, { seq: 1, now });
    expect(JSON.stringify(snapshot)).not.toContain(plaintext);
    const owner = await loadOrCreateShareIdentity(alice); const reader = await loadOrCreateShareIdentity(bob);
    const allowlist = [encodeBase64(owner.publicKey), encodeBase64(reader.publicKey)];
    const handle = createRelayHttpHandler(store, { enabled: true, origins: ["https://eic.example"], keys: allowlist, maxPublishesPerWindow: 5, windowMs: 60000, now: () => now });
    const http = (action: string, body: unknown) => handle(new Request(`https://local.invalid/${action}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://eic.example" }, body: JSON.stringify(body) }));
    const published = await http("publish", { manifest: snapshot.manifest, files: snapshot.files });
    expect(published.status).toBe(200);
    const admitted = await published.json() as { publisherPath: string };
    const tampered = await http("publish", { manifest: snapshot.manifest.replace("alice-id", "tampered"), files: snapshot.files });
    expect(tampered.status).toBe(400);
    const chunkId = "chat-bob-id.json";
    const request = { pubkey: allowlist[1], feedPath: admitted.publisherPath, ts: now.getTime(), nonce: "bob-chunk-nonce", signature: await signRelayRead(reader.secretKey, { feedPath: `${admitted.publisherPath}/chunks/${chunkId}`, ts: now.getTime(), nonce: "bob-chunk-nonce" }), chunkId };
    const response = await http("chunk", request); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json() as { chunk: string };
    expect((await http("chunk", request)).status).toBe(400);
    const envelope = JSON.parse(result.chunk).envelopes[0];
    expect((await applyInboundChatEnvelope(bob, envelope, deps)).applied).toBe(true);
    expect((await applyInboundChatEnvelope(bob, envelope, deps)).applied).toBe(false);
    expect((await listChatThread(bob, "alice-id")).map(m => m.body)).toEqual([plaintext]);
    // First retry loses readback. A second attempt meets an already-committed seq:
    // publish rejects, but fresh signed exact-manifest readback safely confirms it.
    await prepareRelayOutbox(alice, now);
    const pendingBefore = await alice.getJson("relay-outbox:alice-id");
    const publish = async (request: unknown) => { const response = await http("publish", request); if (!response.ok) throw new Error("No acknowledgement"); };
    expect((await attemptRelayOutbox(alice, { publish, read: async () => { throw new Error("lost readback"); } }, now)).status).toBe("pending");
    expect(await alice.getJson("relay-outbox:alice-id")).toEqual(pendingBefore);
    expect((await attemptRelayOutbox(alice, { publish, read: async request => {
      const response = await http("read", request); if (!response.ok) throw new Error("Read denied"); return response.json();
    } }, now)).status).toBe("confirmed");
    expect(await alice.getJson("relay-outbox:alice-id")).toMatchObject({ seq: 1, pending: null });
    const rows = (await db.query("select data from eic_relay.objects")).rows;
    expect(JSON.stringify(rows)).not.toContain(plaintext);
    alice.lock(); bob.lock();
  });

});


it("bounds keys by encoded bytes, preserving the exact 1024-byte boundary", async () => {
  await db.exec("begin");
  try {
    await store.putObject("é".repeat(512), "bounded");
    expect((await store.get("é".repeat(512)))?.data).toBe("bounded");
    await db.exec("savepoint oversize_key");
    await expect(db.query("insert into eic_relay.objects(key,data) values ($1,'x')", ["é".repeat(513)])).rejects.toThrow();
    await db.exec("rollback to savepoint oversize_key");
    const grants = await db.query("select has_table_privilege('service_role','eic_relay.objects','select') as direct");
    expect(grants.rows[0].direct).toBe(false);
  } finally { await db.exec("rollback"); }
});
