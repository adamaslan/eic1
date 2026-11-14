import { afterEach, describe, expect, it, vi } from 'vitest';
import { startForegroundRelay } from './foreground-relay';
afterEach(() => vi.useRealTimers());
describe('foreground relay scheduling', () => {
  it('runs automatically, throttles wake storms and never overlaps', async () => {
    vi.useFakeTimers(); let wake = () => {}; let finish = () => {};
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startForegroundRelay({ active: () => true, run, subscribe: fn => { wake = fn; return () => {}; } });
    expect(run).toHaveBeenCalledTimes(1); wake(); await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(1); finish(); await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2); stop(); finish();
  });
  it('does no work hidden/locked/offline and cleanup cancels timer and events', async () => {
    vi.useFakeTimers(); let active = false; let wake = () => {}; const unsubscribe = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startForegroundRelay({ active: () => active, run, subscribe: fn => { wake = fn; return unsubscribe; } });
    await vi.advanceTimersByTimeAsync(120_000); expect(run).not.toHaveBeenCalled();
    active = true; wake(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
    stop(); wake(); await vi.advanceTimersByTimeAsync(600_000); expect(run).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('backs off failures, caps backoff and permits no unhandled rejection', async () => {
    vi.useFakeTimers(); const run = vi.fn().mockRejectedValue(new Error('unavailable'));
    const stop = startForegroundRelay({ active: () => true, run, subscribe: () => () => {} });
    await vi.advanceTimersByTimeAsync(119_999); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(240_000); expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300_000); expect(run).toHaveBeenCalledTimes(4); stop();
  });
});

import { createVault, type UnlockedVault } from '@veil/vault';
import { SubtleCryptoPort } from '@veil/crypto';
import { MemoryStore } from '../../../../packages/vault/src/memory-store';
import {
  buildFeedSnapshot, buildShareBundle, defaultSettings, importShareBundle,
  listChatThread, listConnections, saveSettings, sendChatMessage,
  type SyncFetcher,
} from '@veil/features';
import type { Settings } from '@veil/core';
import { runForegroundCatchUp } from './foreground-relay';

const NOW = new Date('2026-11-13T20:00:00Z');
const FEED_URL = 'https://f.example/alice';
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
const openVault = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, 'pass phrase 1');
let idCounter = 0;
const newId = () => `m-${++idCounter}`;

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await openVault();
  const bob = await openVault();
  await saveSettings(alice, { ...settingsFor('alice-id', 'alice'), feedUrl: FEED_URL });
  await saveSettings(bob, settingsFor('bob-id', 'bob'));
  await importShareBundle(bob, (await buildShareBundle(alice, { ...settingsFor('alice-id', 'alice'), feedUrl: FEED_URL }, [], NOW)).text, { settings: settingsFor('bob-id', 'bob'), newId, now: NOW });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor('bob-id', 'bob'), [], NOW)).text, { settings: settingsFor('alice-id', 'alice'), newId, now: NOW });
  return { alice, bob };
}

function hostFor(files: { path: string; text: string }[], feedUrl: string) {
  const requests: string[] = [];
  const byUrl = new Map(files.map((f) => [`${feedUrl}/${f.path}`, f.text]));
  const fetch: SyncFetcher = async (url) => {
    requests.push(url);
    const text = byUrl.get(url);
    return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: null, text };
  };
  return { fetch, requests };
}

async function aliceSays(alice: UnlockedVault, body: string, seq: number) {
  const conn = (await listConnections(alice)).find((c) => c.id === 'bob-id')!;
  await sendChatMessage(alice, conn, body, { newId, now: () => NOW });
  return buildFeedSnapshot(alice, { ...settingsFor('alice-id', 'alice'), feedUrl: FEED_URL }, [], { now: NOW, seq });
}

describe('foreground catch-up cursor', () => {
  it('re-reads the persisted cursor: steady-state poll is manifest-only and duplicates nothing', async () => {
    const { alice, bob } = await pairedVaults();
    const snapshot = await aliceSays(alice, 'hi bob', 7);
    const host = hostFor(snapshot.files, FEED_URL);

    const first = await runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: FEED_URL, fetcher: host.fetch, network: 'wifi', newId, now: NOW });
    expect(first?.status).toBe('applied');
    expect(first?.appliedChat).toBe(1);

    // Second poll one minute later: the manifest is fetched once, no chunk re-download, no duplicates.
    const before = host.requests.length;
    const second = await runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: FEED_URL, fetcher: host.fetch, network: 'wifi', newId, now: NOW });
    expect(second?.status).toBe('unchanged');
    expect(host.requests.length).toBe(before + 1);
    expect(host.requests[before]!.endsWith('feed.json')).toBe(true);
    expect((await listChatThread(bob, 'alice-id')).length).toBe(1);
  });

  it('rejects a replayed older manifest against the persisted in-session cursor', async () => {
    const { alice, bob } = await pairedVaults();
    const newer = await aliceSays(alice, 'fresh words', 7);
    const host = hostFor(newer.files, FEED_URL);
    const first = await runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: FEED_URL, fetcher: host.fetch, network: 'wifi', newId, now: NOW });
    expect(first?.status).toBe('applied');

    // A replayed seq-5 snapshot (e.g. stale relay object) must trip the rollback guard even
    // though this page never re-read its connection object: the cursor comes from the vault.
    const stale = await buildFeedSnapshot(alice, { ...settingsFor('alice-id', 'alice'), feedUrl: FEED_URL }, [], { now: NOW, seq: 5 });
    const replayHost = hostFor(stale.files, FEED_URL);
    await expect(runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: FEED_URL, fetcher: replayHost.fetch, network: 'wifi', newId, now: NOW })).rejects.toThrow(/older sequence/);
    expect((await listChatThread(bob, 'alice-id')).map((m) => m.body)).toEqual(['fresh words']);
  });

  it('returns null without any fetch when the open page is stale', async () => {
    const { bob } = await pairedVaults();
    const host = hostFor([], FEED_URL);
    const result = await runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: 'https://f.example/moved', fetcher: host.fetch, network: 'wifi', newId, now: NOW });
    expect(result).toBeNull();
    expect(host.requests.length).toBe(0);
  });
});

describe('foreground catch-up retry accounting', () => {
  it('accumulates the chunk failure counter across polls and exhausts at the bound', async () => {
    const { alice, bob } = await pairedVaults();
    const snapshot = await aliceSays(alice, 'unreachable words', 7);
    // Manifest served, chat chunk 404s every time.
    const host = hostFor(snapshot.files.filter((f) => f.path === 'feed.json'), FEED_URL);
    const run = () => runForegroundCatchUp({ vault: bob, connectionId: 'alice-id', expectedFeedUrl: FEED_URL, fetcher: host.fetch, network: 'wifi', newId, now: NOW });

    const first = await run();
    expect(first?.status).toBe('deferred');
    expect((await listConnections(bob)).find((c) => c.id === 'alice-id')!.syncRetry).toBe(1);

    const second = await run();
    expect(second?.status).toBe('deferred');
    expect((await listConnections(bob)).find((c) => c.id === 'alice-id')!.syncRetry).toBe(2);

    const third = await run();
    expect(third?.status).toBe('partial');
    const conn = (await listConnections(bob)).find((c) => c.id === 'alice-id')!;
    expect(conn.syncRetry).toBe(3);
    expect(conn.syncExhausted).toBe(true);
  });
});
