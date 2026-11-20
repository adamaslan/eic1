import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { encodeBase64 } from "@veil/core";
import {
  RECEIPT_AUTO_RETRY_MAX, buildShareBundle, configureRelayFeed, countUnreceiptedInbound, hasUnacceptedOutbound, importShareBundle,
  listChatThread, listConnections, loadOrCreateShareIdentity, loadSettings, outboundStatus, publishRelaySnapshot, saveSettings,
  sendChatMessage,
} from "@veil/features";
import type { RelayAtomicStore, StoreEntry } from "../../../../packages/features/src/relay-adapter";
import { createRelayHttpHandler } from "../../../../packages/features/src/relay-http";
import { MemoryStore } from "../../../../packages/vault/src/memory-store";
import { createRelayTransport } from "@veil/features";
import { runRelayPass } from "./relay-background";

// Synthetic local vaults and a disposable in-memory relay behind the repo's own HTTP handler. No network.
const ENDPOINT = "https://eic.example/relay";
const ORIGIN = "https://eic.example";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const clock = () => NOW;
const ids = { n: 0 }; const newId = () => `t${ids.n++}`;

function memoryStore(): RelayAtomicStore {
  const rows = new Map<string, StoreEntry>(); let generation = 0;
  return {
    async get(key) { return rows.get(key) ?? null; },
    async compareAndSet(key, data, cond) { const old = rows.get(key); if ("createOnly" in cond ? !!old : old?.generation !== cond.generation) return null; const next = String(++generation); rows.set(key, { data, generation: next }); return next; },
    async putObject(key, data) { rows.set(key, { data, generation: String(++generation) }); },
    async list(prefix, o) { return { keys: [...rows.keys()].filter((k) => k.startsWith(prefix) && (!o?.cursor || k > o.cursor)).sort().slice(0, o?.limit ?? 100) }; },
    async delete(key) { rows.delete(key); },
  };
}

async function world(network: "wifi" | "unknown" | "cellular") {
  // Reads are stamped with Date.now(); the relay rejects stale stamps, so pin the clock to the test instant.
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const store = memoryStore(); const keys: string[] = [];
  const relay = { publishes: 0, reads: 0, failPublish: false, requests: 0 };
  vi.stubGlobal("navigator", network === "unknown" ? {} : { connection: { type: network } });
  const handler = (request: Request) => createRelayHttpHandler(store, { enabled: true, keys: [...keys], origins: [ORIGIN], maxPublishesPerWindow: 100, windowMs: 60000, now: clock })(request);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    relay.requests++;
    const action = url.split("/").pop();
    if (action === "publish") { relay.publishes++; if (relay.failPublish) return new Response("down", { status: 503 }); }
    if (action === "read") relay.reads++;
    return handler(new Request(url, { method: init.method, headers: { ...(init.headers as Record<string, string>), origin: ORIGIN }, body: init.body as string }));
  });
  const make = async (authorId: string, handle: string) => {
    const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: clock }, `pass phrase ${handle}`);
    await saveSettings(vault, { ...(await loadSettings(vault)), authorId, handle });
    keys.push(encodeBase64((await loadOrCreateShareIdentity(vault)).publicKey));
    await configureRelayFeed(vault, ENDPOINT);
    return vault;
  };
  const alice = await make("alice-id", "alice"); const bob = await make("bob-id", "bob");
  const link = async (from: UnlockedVault, to: UnlockedVault) => importShareBundle(to, (await buildShareBundle(from, await loadSettings(from), [], NOW)).text, { settings: await loadSettings(to), newId, now: NOW });
  await link(alice, bob); await link(bob, alice);
  const conn = async (v: UnlockedVault, id: string) => (await listConnections(v)).find((c) => c.id === id)!;
  return { alice, bob, relay, conn };
}
const statusOf = async (v: UnlockedVault, thread: string) => (await listChatThread(v, thread)).filter((m) => m.direction === "out").map((m) => outboundStatus(m));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("runRelayPass: receive-only chats publish a receipt without a reply", () => {
  it("bob -> alice, alice never replies: bob goes queued -> accepted -> delivered, then the exchange goes quiet", async () => {
    const { alice, bob, relay, conn } = await world("wifi");
    await sendChatMessage(bob, await conn(bob, "alice-id"), "hello alice (synthetic)", { newId, now: clock });
    expect(await statusOf(bob, "alice-id")).toEqual(["queued"]);

    expect((await runRelayPass(bob, ENDPOINT, clock)).sent).toBe(true);
    expect(await statusOf(bob, "alice-id")).toEqual(["accepted"]);   // relay confirmed, not delivered

    // Alice has sent nothing and never will in this test. Receiving saves the message and owes a receipt.
    const aliceResult = await runRelayPass(alice, ENDPOINT, clock);
    expect(aliceResult.received).toBe(1);
    expect(aliceResult.sent).toBe(true);                              // the receipt, published in the same pass
    expect(await countUnreceiptedInbound(alice)).toBe(0);
    expect((await listChatThread(alice, "bob-id")).every((m) => m.direction === "in" && m.receiptPublishedAt)).toBe(true);

    expect((await runRelayPass(bob, ENDPOINT, clock)).failed).toBe(0);
    expect(await statusOf(bob, "alice-id")).toEqual(["delivered"]);   // only the recipient's signed receipt did this

    // No receipt loop: further passes publish nothing.
    const publishes = relay.publishes;
    for (let i = 0; i < 3; i++) { await runRelayPass(alice, ENDPOINT, clock); await runRelayPass(bob, ENDPOINT, clock); }
    expect(relay.publishes).toBe(publishes);
  });

  it("an unreachable relay stops automatic receipt publishing after a bound, keeps the owed receipt, and a manual send recovers", async () => {
    const { alice, bob, relay, conn } = await world("wifi");
    await sendChatMessage(bob, await conn(bob, "alice-id"), "hello (synthetic)", { newId, now: clock });
    await runRelayPass(bob, ENDPOINT, clock);
    relay.failPublish = true; const before = relay.publishes;
    for (let i = 0; i < RECEIPT_AUTO_RETRY_MAX + 4; i++) await runRelayPass(alice, ENDPOINT, clock);
    expect(relay.publishes - before).toBe(RECEIPT_AUTO_RETRY_MAX);   // bounded, not one per pass forever
    expect(await countUnreceiptedInbound(alice)).toBe(1);             // still owed, nothing lost
    expect(await statusOf(bob, "alice-id")).toEqual(["accepted"]);    // and never falsely delivered

    relay.failPublish = false;
    expect((await publishRelaySnapshot(alice, createRelayTransport(ENDPOINT), clock)).status).toBe("confirmed");
    expect(await countUnreceiptedInbound(alice)).toBe(0);
    await runRelayPass(bob, ENDPOINT, clock);
    expect(await statusOf(bob, "alice-id")).toEqual(["delivered"]);
  });
});

describe("runRelayPass: unknown network (Safari/iPhone) catches up honestly", () => {
  it("small messages and receipts flow automatically with no setting changed", async () => {
    const { alice, bob, conn } = await world("unknown");
    await sendChatMessage(bob, await conn(bob, "alice-id"), "from iPhone Safari (synthetic)", { newId, now: clock });
    expect((await runRelayPass(bob, ENDPOINT, clock)).sent).toBe(true);
    expect((await runRelayPass(alice, ENDPOINT, clock)).received).toBe(1);
    await runRelayPass(bob, ENDPOINT, clock);
    expect(await statusOf(bob, "alice-id")).toEqual(["delivered"]);
  });

  it("a large backlog waits intact on unknown (nothing sent, nothing failed), and goes once Wi-Fi is reported", async () => {
    const { bob, relay, conn } = await world("unknown");
    const to = await conn(bob, "alice-id");
    for (let i = 0; i < 40; i++) await sendChatMessage(bob, to, `${i} ${"x".repeat(1900)}`, { newId, now: clock });
    // (failed may count the pull of alice's never-published feed; the publish itself is deferred, not failed)
    const result = await runRelayPass(bob, ENDPOINT, clock);
    expect(result.sent).toBe(false);
    expect(relay.publishes).toBe(0);                                   // nothing was sent
    expect(await hasUnacceptedOutbound(bob)).toBe(true);               // and it stays eligible
    expect((await statusOf(bob, "alice-id")).every((s) => s === "queued")).toBe(true);
    vi.stubGlobal("navigator", { connection: { type: "wifi" } });
    expect((await runRelayPass(bob, ENDPOINT, clock)).sent).toBe(true);
    expect((await statusOf(bob, "alice-id")).every((s) => s === "accepted")).toBe(true);
  });

  it("reported cellular is still blocked without the owner's opt-in, and opt-in unblocks it", async () => {
    const { bob, relay, conn } = await world("cellular");
    await sendChatMessage(bob, await conn(bob, "alice-id"), "on mobile data (synthetic)", { newId, now: clock });
    const requestsBefore = relay.requests;
    expect(await runRelayPass(bob, ENDPOINT, clock)).toEqual({ sent: false, received: 0, failed: 0 });
    expect(relay.requests).toBe(requestsBefore);
    await saveSettings(bob, { ...(await loadSettings(bob)), syncOnCellular: true });
    expect((await runRelayPass(bob, ENDPOINT, clock)).sent).toBe(true);
  });
});
