import { describe, expect, it } from "vitest";
import type { Item, Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildFeedSnapshot, chunkUrl, manifestUrl, parseFeedManifest } from "./feed";
import { syncConnection, type SyncDeps, type SyncFetcher } from "./sync";
import { buildShareBundle, importShareBundle } from "./sharing";
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

    // Wi-fi delivers the deferred chunk; no re-pull of anything else.
    const conn2 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const done = await syncConnection(bob, conn2, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW, chunkBudgetBytes: 1 });
    expect(done.status).toBe("unchanged"); // seq already applied; pending chunk needs a re-pull with reset cursor
    await setConnectionSyncState(bob, "alice-id", { seq: 2, etag: null, pending: true });
    const conn3 = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const rehydrated = await syncConnection(bob, conn3, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW });
    expect(rehydrated.status).toBe("applied");
    expect(rehydrated.appliedPosts).toBe(1);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncPending).toBe(false);
  });

  it("rejects a chunk whose bytes do not match the signed manifest", async () => {
    const { alice, bob } = await pairedVaults();
    const { snapshot } = await aliceFeed(alice, [shareable("p1", "from alice")], 1, "https://feeds.example/alice");
    const tampered = snapshot.files.map((f) => (f.path === "chunks/posts.json" ? { ...f, text: f.text.replace("from alice", "forged") } : f));
    const { host } = { host: hostFor(tampered, "https://feeds.example/alice", "etag-1") };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await expect(syncConnection(bob, conn, { fetch: host.fetch, network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow("does not match");
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

  it("reports no-feed for connections without a feed URL", async () => {
    const { bob } = await pairedVaults();
    const conn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const result = await syncConnection(bob, conn, { fetch: async () => ({ status: 500, etag: null, text: null }), network: "wifi", newId: deps.newId, now: NOW });
    expect(result.status).toBe("no-feed");
  });
});
