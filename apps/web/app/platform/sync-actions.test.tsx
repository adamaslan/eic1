import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connection, Settings } from "@veil/core";
import { createVault, type UnlockedVault } from "@veil/vault";
import { SubtleCryptoPort } from "@veil/crypto";
import { MemoryStore } from "../../../../packages/vault/src/memory-store";
import { buildFeedSnapshot, buildShareBundle, importShareBundle, listConnections, saveSettings, defaultSettings, type SyncFetcher } from "@veil/features";
import { getSampleItems } from "../../../../packages/features/src/demo-items";
import { explicitRetryDeps, isFetchExhausted, normalSyncDeps, retryConnectionFailedChunks, syncAllNormally } from "./sync-actions";
import { RetryFailedButton } from "../routes/connections";

const NOW = new Date("2026-10-30T12:00:00Z");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });

const conn = (over: Partial<Connection>): Connection => ({
  id: "author-friend",
  handle: "friend",
  addedAt: "2026-10-29T20:00:00.000Z",
  nickname: null,
  hidden: false,
  lastImportAt: null,
  pubkey: "pk",
  feedUrl: null,
  syncSeq: 0,
  syncEtag: null,
  syncPending: false,
  syncRetry: 0,
  syncExhausted: false,
  syncStatus: "",
  syncDetail: "",
  schemaVersion: 1,
  ...over,
});

describe("retry affordance wiring", () => {
  it("normal sync deps never carry retryFailed; explicit retry deps always do", () => {
    expect("retryFailed" in normalSyncDeps()).toBe(false);
    expect("retryFailed" in normalSyncDeps({ network: "wifi" })).toBe(false);
    expect(explicitRetryDeps().retryFailed).toBe(true);
  });

  it("retry button visibility follows structured state, never the detail string", () => {
    // A connection whose detail happens to mention exhaustion but whose structured state
    // is clear must NOT show the retry affordance.
    const stringOnly = conn({ syncDetail: "rejected: c1 (unreachable after 3 attempts)", syncExhausted: false });
    expect(isFetchExhausted(stringOnly)).toBe(false);
    expect(renderToStaticMarkup(<RetryFailedButton connection={stringOnly} busy={false} onRetry={() => {}} />)).toBe("");
    const exhausted = conn({ syncDetail: "", syncExhausted: true });
    expect(isFetchExhausted(exhausted)).toBe(true);
    expect(renderToStaticMarkup(<RetryFailedButton connection={exhausted} busy={false} onRetry={() => {}} />)).toContain("Retry failed chunks");
  });

  it("normal sync leaves an exhausted feed exhausted; explicit retry recovers exactly that feed", async () => {
    const feedUrlA = "https://f.example/alice";
    const feedUrlB = "https://f.example/bob";
    const alice = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
    const bob = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
    const carol = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
    await saveSettings(alice, settingsFor("alice-id", "alice"));
    await saveSettings(bob, settingsFor("bob-id", "bob"));
    await saveSettings(carol, settingsFor("carol-id", "carol"));
    await importShareBundle(bob, (await buildShareBundle(alice, { ...settingsFor("alice-id", "alice"), feedUrl: feedUrlA }, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: () => "x1", now: NOW });
    await importShareBundle(bob, (await buildShareBundle(carol, { ...settingsFor("carol-id", "carol"), feedUrl: feedUrlB }, [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: () => "x2", now: NOW });

    const item = { ...getSampleItems(NOW)[1]!, id: "itm-1", title: "t", description: "", mediaIds: [], thumbId: null, visibility: "shareable" as const, authorId: null, authorHandle: null, likedBy: [] };
    const snapshotA = await buildFeedSnapshot(alice, { ...settingsFor("alice-id", "alice"), feedUrl: feedUrlA }, [item], { now: NOW, seq: 1 });
    const snapshotB = await buildFeedSnapshot(carol, { ...settingsFor("carol-id", "carol"), feedUrl: feedUrlB }, [item], { now: NOW, seq: 1 });
    // Alice's host 404s every chunk; Bob-the-peer's host is healthy.
    const hostFor = (files: { path: string; text: string }[], feedUrl: string) => {
      const byUrl = new Map(files.map((f) => [`${feedUrl}/${f.path}`, f.text]));
      const requests: string[] = [];
      const fetch: SyncFetcher = async (url, ifNoneMatch) => {
        requests.push(url);
        if (ifNoneMatch === "e" && url === `${feedUrl}/feed.json`) return { status: 304, etag: "e", text: null };
        const text = byUrl.get(url);
        return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: url === `${feedUrl}/feed.json` ? "e" : null, text };
      };
      return { fetch, requests };
    };
    const hostA = hostFor(snapshotA.files.filter((f) => f.path === "feed.json"), feedUrlA);
    const hostB = hostFor(snapshotB.files, feedUrlB);
    let fetching: "A" | "B" = "A";
    const fetch: SyncFetcher = (url, etag) => (url.startsWith(feedUrlA) ? hostA.fetch(url, etag) : hostB.fetch(url, etag));
    void fetching;

    const deps = { fetch, network: "wifi" as const, newId: () => "m1", now: NOW };
    // Exhaust alice's feed through NORMAL syncs (the wiring must not reset the budget).
    let last = new Map<string, { status: string }>();
    for (let i = 0; i < 3; i++) last = await syncAllNormally(bob, deps);
    expect(last.get("alice-id")!.status).toBe("partial");
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncExhausted).toBe(true);
    const connA = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    expect(connA.syncExhausted).toBe(true);

    // A normal sync must NOT recover an exhausted feed (no chunk re-fetch, stays exhausted).
    const chunkReqsBefore = hostA.requests.filter((u) => !u.endsWith("feed.json")).length;
    await syncAllNormally(bob, deps);
    expect(hostA.requests.filter((u) => !u.endsWith("feed.json")).length).toBe(chunkReqsBefore);
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncExhausted).toBe(true);

    // Explicit retry targets exactly that connection and recovers the repaired feed.
    const repairedA = hostFor(snapshotA.files, feedUrlA);
    const depsRetry = { fetch: ((url: string, etag: string | null) => (url.startsWith(feedUrlA) ? repairedA.fetch(url, etag) : hostB.fetch(url, etag))) as SyncFetcher, network: "wifi" as const, newId: () => "m2", now: NOW };
    const hostBReqsBefore = hostB.requests.length;
    const retryResult = await retryConnectionFailedChunks(bob, connA, depsRetry);
    expect(retryResult.status).toBe("applied");
    expect((await listConnections(bob)).find((c) => c.id === "alice-id")!.syncExhausted).toBe(false);
    // The other connection was never touched by the explicit retry.
    expect(hostB.requests.length).toBe(hostBReqsBefore);
  });
});
