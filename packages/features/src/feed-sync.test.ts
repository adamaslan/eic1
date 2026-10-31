import { describe, expect, it } from "vitest";
import { encodeBase64, type Item, type Settings } from "@veil/core";
import { SubtleCryptoPort, signPayload } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildFeedSnapshot, chunkUrl, manifestUrl, parseFeedManifest } from "./feed";
import { MAX_CHUNK_FETCH_RETRIES, syncAllConnections, syncConnection, type SyncDeps, type SyncFetcher } from "./sync";
import { buildShareBundle, importShareBundle, loadOrCreateShareIdentity } from "./sharing";
import { defaultSettings, listConnections, saveSettings, setConnectionSyncState } from "./social";
import { listChatThread, sendChatMessage } from "./chat";
import { getSampleItems } from "./demo-items";

const NOW = new Date("2026-10-30T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const deps = { newId: () => `m${counter++}`, now: () => NOW };

const shareable = (id: string, title: string): Item => ({
  ...getSampleItems(NOW)[1]!,
  id,
  title,
  description: "",
  mediaIds: [],
  thumbId: null,
  visibility: "shareable",
  authorId: null,
  authorHandle: null,
  likedBy: [],
});

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
  return { alice, bob };
}

/** In-memory static host: serves a snapshot, honors If-None-Match on the manifest. */
function hostFor(files: { path: string; text: string }[], feedUrl: string, etag: string): { fetch: SyncFetcher; requests: string[] } {
  const requests: string[] = [];
  const byUrl = new Map(files.map((f) => [`${feedUrl}/${f.path}`, f.text]));
  const fetch: SyncFetcher = async (url, ifNoneMatch) => {
    requests.push(url);
    if (url === manifestUrl(feedUrl) && ifNoneMatch === etag) return { status: 304, etag, text: null };
    const text = byUrl.get(url);
    if (text === undefined) return { status: 404, etag: null, text: null };
    return { status: 200, etag: url === manifestUrl(feedUrl) ? etag : null, text };
  };
  return { fetch, requests };
}

async function aliceFeed(alice: UnlockedVault, items: Item[], seq: number, feedUrl: string) {
  const settings = settingsFor("alice-id", "alice");
  const snapshot = await buildFeedSnapshot(alice, { ...settings, feedUrl }, items, { now: NOW, seq });
  return { snapshot, host: hostFor(snapshot.files, feedUrl, `etag-${seq}`) };
}

describe("feed publish (eic-feed v1)", () => {
  it("builds a signed manifest whose chunks cover posts and chat, ciphertext only", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConnForBob = (await listConnections(alice)).find((c) => c.id === "bob-id")!;
    await sendChatMessage(alice, aliceConnForBob, "secret words", deps);
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "public thing"), shareable("p2", "another")], 1, "https://feeds.example/alice");

    const manifest = parseFeedManifest(snapshot.manifest);
    expect(manifest.authorId).toBe("alice-id");
    expect(manifest.seq).toBe(1);
    expect(manifest.chunks.map((c) => c.kind)).toEqual(["posts", "chat"]);

    // Leak gate: no private post content anywhere in the feed files.
    const everything = snapshot.manifest + snapshot.files.map((f) => f.text).join("");
    expect(everything).toContain("public thing");
    expect(everything).not.toContain("secret words");

    // A tampered manifest fails verification on pull.
    const tampered = JSON.stringify({ ...JSON.parse(snapshot.manifest), seq: 99 });
    await expect(aliceFeed(alice, [], 1, "https://feeds.example/alice")).resolves.toBeTruthy();
    const { host } = await aliceFeed(alice, [], 1, "https://feeds.example/alice");
    const badHost: SyncFetcher = async (url) =>
      url === manifestUrl("https://feeds.example/alice") ? { status: 200, etag: "x", text: tampered } : host.fetch(url, null);
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await expect(syncConnection(bob, conn, { fetch: badHost, network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow("signature");
  });
});

describe("pull sync", () => {
  it("applies posts and chat once, then reports unchanged on seq and etag", async () => {
    const { alice, bob } = await pairedVaults();
    const bobConnOnAlice = (await listConnections(alice)).find((c) => c.id === "bob-id")!;
    await sendChatMessage(alice, bobConnOnAlice, "hi bob", deps);
    const { host } = await aliceFeed(alice, [shareable("p1", "from alice")], 7, "https://feeds.example/alice");

    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const first = await syncConnection(bob, conn, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(first.status).toBe("applied");
    expect(first.appliedPosts).toBe(1);
    expect(first.appliedChat).toBe(1);
    expect((await listChatThread(bob, "alice-id")).map((m) => m.body)).toEqual(["hi bob"]);

    // Second pull: etag short-circuits before any chunk fetch; nothing duplicates.
    const synced = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const before = host.requests.length;
    const second = await syncConnection(bob, synced, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(second.status).toBe("unchanged");
    expect(host.requests.length).toBe(before + 1); // only the manifest
    expect((await listChatThread(bob, "alice-id")).length).toBe(1);

    // Even a forced re-pull of the same seq applies nothing twice.
    await setConnectionSyncState(bob, "alice-id", { seq: 7, etag: null, pending: false });
    const conn3 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const third = await syncConnection(bob, conn3, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(third.status).toBe("unchanged");
  });

  it("is wi-fi only by default, defers oversized chunks on cellular, and delivers them on wi-fi", async () => {
    const { alice, bob } = await pairedVaults();
    const { host } = await aliceFeed(alice, [shareable("p1", "from alice")], 3, "https://feeds.example/alice");
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };

    // Default: cellular does not even fetch the manifest.
    const blocked = await syncConnection(bob, conn, { fetch: host.fetch, network: "cellular", newId: deps.newId, now: NOW });
    expect(blocked.status).toBe("deferred");
    expect(host.requests.length).toBe(0);

    // Cellular opt-in with a tiny budget: chunks defer, cursor still advances, pending is recorded.
    const settings = await saveSettings(bob, { ...settingsFor("bob-id", "bob"), syncOnCellular: true });
    expect(settings.syncOnCellular).toBe(true);
    const partial = await syncConnection(bob, conn, { fetch: host.fetch, network: "cellular", newId: deps.newId, now: NOW, chunkBudgetBytes: 1 });
    expect(partial.status).toBe("deferred");
    expect(partial.pendingChunks).toEqual(["posts.json"]);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncPending).toBe(true);

    // Wi-fi retries the pending chunk against the SAME manifest (etag skipped while pending);
    // no sender republish or manual reset needed. Chunk application is idempotent.
    const conn2 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const delivered = await syncConnection(bob, conn2, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(delivered.status).toBe("applied");
    expect(delivered.appliedPosts).toBe(1);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncPending).toBe(false);

    // Once nothing is pending, the etag shortcut applies again.
    const before = host.requests.length;
    const conn3 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const settled = await syncConnection(bob, conn3, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(settled.status).toBe("unchanged");
    expect(host.requests.length).toBe(before + 1); // only the manifest, answered 304
  });

  it("rejects a chunk whose bytes do not match the signed manifest", async () => {
    const { alice, bob } = await pairedVaults();
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "from alice")], 1, "https://feeds.example/alice");
    const tampered = snapshot.files.map((f) => (f.path === "chunks/posts.json" ? { ...f, text: f.text.replace("from alice", "forged") } : f));
    const { host } = { host: hostFor(tampered, "https://feeds.example/alice", "etag-1") };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result = await syncConnection(bob, conn, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("partial");
    expect(result.rejectedChunks).toContain("posts.json");
  });

  it("rehydrates a fresh vault from a feed: posts come back; envelopes sealed to the lost key cannot be opened", async () => {
    const { alice, bob } = await pairedVaults();
    const bobConnOnAlice = (await listConnections(alice)).find((c) => c.id === "bob-id")!;
    await sendChatMessage(alice, bobConnOnAlice, "sealed to the old key", deps);
    const { host } = await aliceFeed(alice, [shareable("p1", "old post")], 12, "https://feeds.example/alice");

    // Bob loses his vault; a fresh one (new identity key) re-imports Alice's share file and pulls.
    const freshBob = await open();
    await saveSettings(freshBob, settingsFor("bob-id", "bob"));
    await importShareBundle(freshBob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
    const conn = { ...(await listConnections(freshBob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result = await syncConnection(freshBob, conn, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("applied");
    expect(result.appliedChat).toBe(0); // sealed to the lost key: cannot be opened, dropped, not fatal (history policy is the owner's open #42 call)
    const items = await freshBob.listItems();
    expect(items.some((i) => i.title === "old post" && i.authorId === "alice-id")).toBe(true);

    // A new message sealed to the current key applies on the next pull.
    await importShareBundle(alice, (await buildShareBundle(freshBob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
    const freshBobConn = (await listConnections(alice)).find((c) => c.id === "bob-id")!;
    await sendChatMessage(alice, freshBobConn, "sealed to the new key", deps);
    const feed2 = await aliceFeed(alice, [shareable("p1", "old post")], 13, "https://feeds.example/alice");
    const conn2 = { ...(await listConnections(freshBob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result2 = await syncConnection(freshBob, conn2, { fetch: feed2.host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(result2.appliedChat).toBe(1);
    expect((await listChatThread(freshBob, "alice-id")).map((m) => m.body)).toEqual(["sealed to the new key"]);
  });

  it("syncAllConnections isolates per-connection failures: a corrupt feed does not abort the rest", async () => {
    const { alice, bob } = await pairedVaults();
    const { host } = await aliceFeed(alice, [shareable("p1", "from alice")], 7, "https://feeds.example/alice");

    // Carol's manifest is tampered after signing - her connection fails closed.
    const carol = await open();
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    await importShareBundle(carol, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("carol-id", "carol"), newId: deps.newId, now: NOW });
    const carolFeed = await aliceFeed(carol, [], 1, "https://feeds.example/carol");
    const tamperedManifest = JSON.stringify({ ...JSON.parse(carolFeed.snapshot.manifest), seq: 99 });
    await importShareBundle(bob, (await buildShareBundle(carol, settingsFor("carol-id", "carol"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });

    // Persist feed URLs on bob's connections (imported from each author's v2 bundle).
    const aliceWithFeed = { ...settingsFor("alice-id", "alice"), feedUrl: "https://feeds.example/alice" };
    await importShareBundle(bob, (await buildShareBundle(alice, aliceWithFeed, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
    const carolWithFeed = { ...settingsFor("carol-id", "carol"), feedUrl: "https://feeds.example/carol" };
    await importShareBundle(bob, (await buildShareBundle(carol, carolWithFeed, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
    const fetchMulti: SyncFetcher = async (url) => {
      if (url.startsWith("https://feeds.example/alice")) return host.fetch(url, null);
      if (url.endsWith("feed.json")) return { status: 200, etag: "x", text: tamperedManifest };
      return carolFeed.host.fetch(url, null);
    };
    const results = await syncAllConnections(bob, { fetch: fetchMulti, network: "wifi", newId: deps.newId, now: NOW });
    expect(results.get("carol-id")!.status).toBe("failed");
    expect(results.get("alice-id")!.status).toBe("applied");
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(7);
  });

  it("skips unknown chunk kinds from a newer feed version instead of failing the manifest", async () => {
    const { alice, bob } = await pairedVaults();
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "from alice")], 5, "https://feeds.example/alice");
    // Inject a chunk of a kind this code does not know, and re-sign the manifest with Alice's key.
    const manifest = JSON.parse(snapshot.manifest);
    const futureBytes = new TextEncoder().encode("future-data");
    const futureHash = encodeBase64(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", futureBytes)));
    manifest.chunks.push({ id: "future.json", kind: "hologram", bytes: 11, sha256: futureHash });
    const { signature, ...unsigned } = manifest;
    void signature;
    const identity = await loadOrCreateShareIdentity(alice);
    const reSigned = JSON.stringify({ ...unsigned, signature: encodeBase64(await signPayload(identity.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)))) });
    const byUrl = new Map(snapshot.files.map((f) => [`https://feeds.example/alice/${f.path}`, f.text]));
    byUrl.set("https://feeds.example/alice/feed.json", reSigned);
    byUrl.set("https://feeds.example/alice/chunks/future.json", "future-data");
    const fetch: SyncFetcher = async (url) => {
      const text = byUrl.get(url);
      return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: "e5", text };
    };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result = await syncConnection(bob, conn, { fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("applied");
    expect(result.appliedPosts).toBe(1);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(5);
  });

  it("refuses a same-key low-seq republish as a silent rollback (recovery stays manual)", async () => {
    const { alice, bob } = await pairedVaults();
    const { host: host7 } = await aliceFeed(alice, [shareable("p1", "week one")], 7, "https://feeds.example/alice");
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await syncConnection(bob, conn, { fetch: host7.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(7);

    // A replayed/older snapshot at seq 3 must NOT roll back newer state: reject with an
    // actionable error. Recovery after a vault rebuild is explicit - re-import the bundle,
    // which clears the cursor - not a silent downgrade.
    const { host: host3 } = await aliceFeed(alice, [shareable("p1", "week one")], 3, "https://feeds.example/alice");
    const conn2 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await expect(syncConnection(bob, conn2, { fetch: host3.fetch, network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow("older sequence");
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(7);
  });

  it("rejects a permanently invalid chunk once without retrying it or masquerading as deferred", async () => {
    const { alice, bob } = await pairedVaults();
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "week one"), shareable("p2", "week two")], 4, "https://feeds.example/alice");
    // Corrupt one chunk on the wire: its hash no longer matches the signed manifest.
    const byUrl = new Map(snapshot.files.map((f) => [`https://feeds.example/alice/${f.path}`, f.text]));
    byUrl.set("https://feeds.example/alice/chunks/posts.json", '{"forged":true}');
    const fetch: SyncFetcher = async (url) => {
      const text = byUrl.get(url);
      return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: "e9", text };
    };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result = await syncConnection(bob, conn, { fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("partial");
    expect(result.rejectedChunks).toContain("posts.json");
    expect(result.pendingChunks).toHaveLength(0);
    // The cursor advances past the rejected chunk, so the next pull takes the etag shortcut
    // instead of refetching the invalid chunk forever.
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(4);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncPending).toBe(false);
    const again = await syncConnection(bob, { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" }, { fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(again.status).toBe("unchanged");
    expect(again.rejectedChunks).toHaveLength(0);
    // The outcome is durable and user-visible on the connection, not just the helper result.
    const after = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    expect(after.syncStatus).toBe("partial");
    expect(after.syncDetail).toContain("posts.json");
  });

  it("defers and retries a chunk whose fetch fails transiently (no terminal rejection)", async () => {
    const { alice, bob } = await pairedVaults();
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "week one")], 4, "https://feeds.example/alice");
    const byUrl = new Map(snapshot.files.map((f) => [`https://feeds.example/alice/${f.path}`, f.text]));
    let chunkFails = true;
    const fetch: SyncFetcher = async (url) => {
      if (chunkFails && url.includes("/chunks/")) return { status: 500, etag: null, text: null };
      const text = byUrl.get(url);
      return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: "e4", text };
    };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const first = await syncConnection(bob, conn, { fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(first.status).toBe("deferred");
    expect(first.pendingChunks).toContain("posts.json");
    expect(first.rejectedChunks).toHaveLength(0);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncPending).toBe(true);

    // The host recovers; the same manifest is retried and applies - no republish needed.
    chunkFails = false;
    const conn2 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const second = await syncConnection(bob, conn2, { fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(second.status).toBe("applied");
    expect(second.appliedPosts).toBe(1);
    expect(second.rejectedChunks).toHaveLength(0);
  });

  it("recovers from a low-seq rejection only via explicit re-import, which clears the cursor", async () => {
    const { alice, bob } = await pairedVaults();
    const { host: host7 } = await aliceFeed(alice, [shareable("p1", "week one")], 7, "https://feeds.example/alice");
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await syncConnection(bob, conn, { fetch: host7.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(7);

    // Alice rebuilds her vault and republishes at seq 3: the pull refuses to roll back.
    const { host: host3 } = await aliceFeed(alice, [shareable("p1", "week one")], 3, "https://feeds.example/alice");
    const conn2 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await expect(syncConnection(bob, conn2, { fetch: host3.fetch, network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow("older sequence");

    // Bob explicitly re-imports Alice's bundle: cursors clear, and the rebuilt feed applies.
    await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
    const reset = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    expect(reset.syncSeq).toBe(0);
    expect(reset.syncEtag).toBeNull();
    expect(reset.syncPending).toBe(false);
    const conn3 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const recovered = await syncConnection(bob, conn3, { fetch: host3.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(recovered.status).toBe("applied");
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncSeq).toBe(3);
  });

  it("rejects a connection whose feed URL is not https (except localhost)", async () => {
    const { bob } = await pairedVaults();
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "http://evil.example/alice" };
    await expect(syncConnection(bob, conn, { fetch: async () => ({ status: 200, etag: null, text: "" }), network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow("https");
  });

  it("reports no-feed for connections without a feed URL", async () => {
    const { bob } = await pairedVaults();
    const conn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const result = await syncConnection(bob, conn, { fetch: async () => ({ status: 500, etag: null, text: null }), network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("no-feed");
  });
});

it("terminally rejects an unreachable chunk after MAX_CHUNK_FETCH_RETRIES instead of retrying forever", async () => {
  const feedUrl = "https://f.example/alice";
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  // Bob imports alice's bundle, which carries her feed URL.
  await importShareBundle(bob, (await buildShareBundle(alice, { ...settingsFor("alice-id", "alice"), feedUrl }, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  const item = shareable("itm-retry", "will be lost");
  const { snapshot } = await aliceFeed(alice, [item], 1, feedUrl);
  // Host serves the manifest but 404s every chunk.
  const onlyManifest = hostFor(snapshot.files.filter((f) => f.path === "feed.json"), feedUrl, "etag-1");

  const run = () => syncAllConnections(bob, { fetch: onlyManifest.fetch, network: "wifi", newId: deps.newId, now: NOW });

  const persisted = async () => (await listConnections(bob)).find((c) => c.id === "alice-id")!;
  for (let i = 0; i < MAX_CHUNK_FETCH_RETRIES - 1; i++) {
    const results = await run();
    expect(results.get("alice-id")!.status).toBe("deferred");
    expect((await persisted()).syncDetail).toMatch(/^pending: /);
    expect((await persisted()).syncPending).toBe(true);
  }

  const final = await run();
  expect(final.get("alice-id")!.status).toBe("partial");
  expect((await persisted()).syncDetail).toContain(`unreachable after ${MAX_CHUNK_FETCH_RETRIES} attempts`);
  expect((await persisted()).syncPending).toBe(false);

  // Cursor advanced past the lost chunk; the host is never re-fetched for this seq.
  const chunkRequestsAfter = onlyManifest.requests.filter((u) => u !== manifestUrl(feedUrl)).length;
  await run();
  expect(onlyManifest.requests.filter((u) => u !== manifestUrl(feedUrl)).length).toBe(chunkRequestsAfter);
  expect((await listChatThread(bob, "alice-id")).map((m) => m.body)).toHaveLength(0);

  // Explicit user retry: the author repaired the chunk under the same seq; a manual retry
  // re-pulls (bypassing the etag shortcut) and applies it - signature and rollback checks intact.
  const repaired = hostFor(snapshot.files, feedUrl, "etag-1");
  const retriedRepaired = await syncAllConnections(bob, { fetch: repaired.fetch, network: "wifi", retryFailed: true, newId: deps.newId, now: NOW });
  expect(retriedRepaired.get("alice-id")!.status).toBe("applied");
  expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncDetail).toBe("");

  // A later, healthy manifest still applies, and the retry budget restarts per manifest:
  // a first failure on the new seq defers instead of exhausting on the old counter.
  const broken2 = await aliceFeed(alice, [shareable("itm-b2", "later loss")], 2, feedUrl);
  const onlyManifest2 = hostFor(broken2.snapshot.files.filter((f) => f.path === "feed.json"), feedUrl, "etag-2");
  const seq2first = await syncAllConnections(bob, { fetch: onlyManifest2.fetch, network: "wifi", newId: deps.newId, now: NOW });
  expect(seq2first.get("alice-id")!.status).toBe("deferred");
  expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncRetry).toBe(1);

  // Rollback protection still holds under an explicit retry: replaying the older seq fails.
  const replayed = await syncAllConnections(bob, { fetch: repaired.fetch, network: "wifi", retryFailed: true, newId: deps.newId, now: NOW });
  expect(replayed.get("alice-id")!.status).toBe("failed");
  expect(replayed.get("alice-id")!.error).toContain("older sequence");
});

it("keeps budget-deferred chunks pending when fetch retries exhaust on another chunk", async () => {
  const feedUrl = "https://f.example/alice";
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, { ...settingsFor("bob-id", "bob"), syncOnCellular: true });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
  await importShareBundle(bob, (await buildShareBundle(alice, { ...settingsFor("alice-id", "alice"), feedUrl }, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  const bobOnAlice = (await listConnections(alice)).find((c) => c.id === "bob-id")!;
  await sendChatMessage(alice, bobOnAlice, "chat for the small chunk", deps);
  const { snapshot } = await aliceFeed(alice, [shareable("itm-big", "big post")], 1, feedUrl);
  const manifest = parseFeedManifest(snapshot.files.find((f) => f.path === "feed.json")!.text);
  const small = manifest.chunks.find((c) => c.kind === "chat")!;
  const big = manifest.chunks.find((c) => c.kind === "posts")!;
  expect(big.bytes).toBeGreaterThan(small.bytes);
  // Host serves the manifest and every chunk except the small one; the budget only fits the small one.
  const served = snapshot.files.filter((f) => f.path !== `chunks/${small.id}`);
  const host = hostFor(served, feedUrl, "etag-1");
  const depsMetered = { fetch: host.fetch, network: "cellular" as const, chunkBudgetBytes: small.bytes, newId: deps.newId, now: NOW };

  for (let i = 0; i < MAX_CHUNK_FETCH_RETRIES; i++) await syncAllConnections(bob, depsMetered);

  const conn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
  // The 404ing chunk is terminally rejected; the over-budget chunk stays pending, not rejected.
  expect(conn.syncDetail).toContain(`rejected: ${small.id}`);
  expect(conn.syncDetail).toContain(`pending: ${big.id}`);
  expect(conn.syncPending).toBe(true);
  expect(conn.syncStatus).toBe("deferred");

  // On wi-fi the manifest is re-processed because the budget-deferred chunk is still pending:
  // both it and the previously fetch-failed chunk are re-fetched, verify, and apply - the
  // budget deferral was never lost behind the cursor, and the fetch failure heals on a healthy host.
  const fixed = hostFor(snapshot.files, feedUrl, "etag-1");
  const onWifi = await syncAllConnections(bob, { fetch: fixed.fetch, network: "wifi", newId: deps.newId, now: NOW });
  expect(onWifi.get("alice-id")!.status).toBe("applied");
  expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncDetail).toBe("");
  expect((await listChatThread(bob, "alice-id")).map((m) => m.body)).toEqual(["chat for the small chunk"]);
});

it("defers truthfully on unknown connectivity instead of claiming cellular", async () => {
  const { bob } = await pairedVaults();
  const feedUrl = "https://f.example/alice";
  const alice = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  const { host } = await aliceFeed(alice, [shareable("itm-u", "held back")], 1, feedUrl);
  await importShareBundle(bob, (await buildShareBundle(alice, { ...settingsFor("alice-id", "alice"), feedUrl }, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });

  // Browser cannot report a transport: sync defers without fetching anything, and the
  // persisted status says the connection type is unknown - it never claims "cellular".
  const deferred = await syncAllConnections(bob, { fetch: host.fetch, network: "unknown", newId: deps.newId, now: NOW });
  expect(deferred.get("alice-id")!.status).toBe("deferred");
  expect(host.requests).toHaveLength(0);
  const conn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
  expect(conn.syncStatus).toBe("deferred");
  expect(conn.syncDetail).toContain("unknown");
  expect(conn.syncDetail).not.toContain("cellular sync is off");

  // Explicit opt-in (settings.syncOnCellular) is the honest path through the budget.
  await saveSettings(bob, { ...settingsFor("bob-id", "bob"), syncOnCellular: true });
  const applied = await syncAllConnections(bob, { fetch: host.fetch, network: "unknown", newId: deps.newId, now: NOW });
  expect(applied.get("alice-id")!.status).toBe("applied");
});
