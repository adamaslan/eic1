import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import {
  admitRelayPublish,
  countingStore,
  serveRelayChunk,
  serveRelayRead,
  signRelayRead,
  sweepExpiredNonces,
  RELAY_MAX_NONCE_CHARS,
  type RelayAtomicStore,
  type StoreEntry,
} from "./relay-adapter";
import { publisherPath } from "./chat-relay";
import { FEED_FORMAT, FEED_VERSION } from "./feed";

/** In-memory store with genuinely atomic CAS (check+set in one synchronous step). */
function memStore(barrier?: { wait(): Promise<void> }) {
  const data = new Map<string, StoreEntry>();
  let gen = 0;
  const store: RelayAtomicStore = {
    async get(path) {
      await barrier?.wait();
      return data.get(path) ?? null;
    },
    async compareAndSet(path, text, cond) {
      const cur = data.get(path);
      if ("createOnly" in cond) {
        if (cur) return null;
      } else if (!cur || cur.generation !== cond.generation) {
        return null;
      }
      gen += 1;
      const generation = `g${gen}`;
      data.set(path, { data: text, generation });
      return generation;
    },
    async putObject(path, text) {
      gen += 1;
      data.set(path, { data: text, generation: `g${gen}` });
    },
    async list(prefix, opts) {
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limit = opts?.limit ?? all.length;
      const start = opts?.cursor ? all.indexOf(opts.cursor) + 1 : 0;
      const keys = all.slice(start, start + limit);
      return { keys, nextCursor: start + limit < all.length ? keys[keys.length - 1] : undefined };
    },
    async delete(path) {
      data.delete(path);
    },
  };
  return { store, data };
}

async function signedPublish(opts: { seq: number; key?: Awaited<ReturnType<typeof generateSigningKeyPair>>; builtAt?: string }) {
  const key = opts.key ?? (await generateSigningKeyPair());
  const chunk = JSON.stringify({ format: "eic-feed-chunk", version: 1, kind: "chat", envelopes: [] });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(chunk));
  const unsigned = {
    format: FEED_FORMAT,
    version: FEED_VERSION,
    authorId: "author-1",
    feedUrl: "https://relay.example/feeds/x",
    pubkey: encodeBase64(key.publicKey),
    seq: opts.seq,
    builtAt: opts.builtAt ?? "2026-10-31T00:00:00.000Z",
    chunks: [{ id: "chat-peer.json", kind: "chat", bytes: new TextEncoder().encode(chunk).byteLength, sha256: encodeBase64(new Uint8Array(digest)) }],
  };
  const signature = await signPayload(key.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const manifest = JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
  return { key, request: { manifest, files: [{ path: "feed.json", text: manifest }, { path: "chunks/chat-peer.json", text: chunk }] } };
}

const OPTS = { maxPublishesPerWindow: 2, windowMs: 60_000, now: new Date("2026-10-31T00:00:00Z") };

async function readRequest(key: Awaited<ReturnType<typeof generateSigningKeyPair>>, feedPath: string, ts: number, nonce: string) {
  return { pubkey: encodeBase64(key.publicKey), feedPath, ts, nonce, signature: await signRelayRead(key.secretKey, { feedPath, ts, nonce }) };
}

describe("admitRelayPublish", () => {
  it("admits a valid publish into immutable seq-keyed objects and records ops", async () => {
    const { store, data } = memStore();
    const { key, request } = await signedPublish({ seq: 1 });
    const result = await admitRelayPublish(store, request, OPTS);
    expect(result.publisherPath).toBe(await publisherPath(encodeBase64(key.publicKey)));
    expect(data.has(`${result.publisherPath}/objects/1/feed.json`)).toBe(true);
    expect(data.has(`${result.publisherPath}/objects/1/chunks/chat-peer.json`)).toBe(true);
    const state = JSON.parse(data.get(`${result.publisherPath}/.state.json`)!.data);
    expect(state.committed).toBe(true);
    expect(state.current).toBe("objects/1/feed.json");
    expect(result.ops).toEqual({ reads: 1, casAttempts: 2, writes: 2, lists: 0, deletes: 0 });
  });

  it("rejects an invalid signature before any store operation", async () => {
    const { store } = memStore();
    const { request } = await signedPublish({ seq: 1 });
    const { store: counted, ops } = countingStore(store);
    await expect(
      admitRelayPublish(counted, { manifest: request.manifest.replace('"seq":1', '"seq":9'), files: request.files }, OPTS),
    ).rejects.toThrow(/signature/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
  });

  it("resolves a concurrent same-seq publish race: exactly one wins, the other is denied", async () => {
    let waiting = 0;
    const barrier = {
      async wait() {
        waiting += 1;
        if (waiting < 2) await new Promise((r) => setTimeout(r, 50));
      },
    };
    const { store } = memStore(barrier);
    const key = await generateSigningKeyPair();
    const a = await signedPublish({ seq: 5, key });
    const b = await signedPublish({ seq: 5, key });
    const results = await Promise.allSettled([
      admitRelayPublish(store, a.request, OPTS),
      admitRelayPublish(store, b.request, OPTS),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((r) => r.status === "rejected");
    expect((denied as PromiseRejectedResult).reason.message).toMatch(/not newer|newer publish/);
  });

  it("never serves an older publish that loses the commit race to a newer seq", async () => {
    const { store, data } = memStore();
    const key = await generateSigningKeyPair();
    const path = await publisherPath(encodeBase64(key.publicKey));
    const old = await signedPublish({ seq: 7, key });
    const newer = await signedPublish({ seq: 8, key });

    const realPut = store.putObject.bind(store);
    let stalled: (() => void) | null = null;
    let firstWrite = true;
    store.putObject = (p, t) => {
      if (!firstWrite) return realPut(p, t);
      firstWrite = false;
      return new Promise<void>((resolve) => { stalled = () => { realPut(p, t).then(resolve); }; });
    };
    const oldPromise = admitRelayPublish(store, old.request, OPTS);
    await new Promise((r) => setTimeout(r, 50)); // old claimed, parked in putObject

    await admitRelayPublish(store, newer.request, OPTS); // newer claims + commits fully
    stalled!(); // old resumes, writes orphan objects, its flip must fail
    await expect(oldPromise).rejects.toThrow(/newer publish superseded/);

    const state = JSON.parse(data.get(`${path}/.state.json`)!.data);
    expect(state.lastSeq).toBe(8);
    expect(state.committed).toBe(true);
    expect(state.current).toBe("objects/8/feed.json");
    const reader = await generateSigningKeyPair();
    const now = OPTS.now.getTime() + 1000;
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const served = await serveRelayRead(store, req, { now: new Date(now + 500) });
    expect(JSON.parse(served.manifest).seq).toBe(8);
  });

  it("rejects a rollback (older seq) even after a successful publish", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    await admitRelayPublish(store, (await signedPublish({ seq: 7, key })).request, OPTS);
    await expect(admitRelayPublish(store, (await signedPublish({ seq: 3, key })).request, OPTS)).rejects.toThrow(/not newer/);
  });

  it("resumes a same-seq, same-manifest retry after a mid-commit crash", async () => {
    const { store, data } = memStore();
    const key = await generateSigningKeyPair();
    const { request } = await signedPublish({ seq: 4, key });
    const path = await publisherPath(encodeBase64(key.publicKey));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.manifest));
    await store.putObject(`${path}/.state.json`, JSON.stringify({
      lastSeq: 4, windowStartMs: OPTS.now.getTime(), windowCount: 1,
      manifestSha: encodeBase64(new Uint8Array(digest)), committed: false,
    }));
    const result = await admitRelayPublish(store, request, OPTS);
    expect(result.publisherPath).toBe(path);
    const state = JSON.parse(data.get(`${path}/.state.json`)!.data);
    expect(state.committed).toBe(true);
    expect(state.windowCount).toBe(1);
    expect(data.has(`${path}/objects/4/feed.json`)).toBe(true);
  });

  it("rejects a same-seq retry with a DIFFERENT manifest (rollback attempt)", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const first = await signedPublish({ seq: 4, key });
    await admitRelayPublish(store, first.request, OPTS);
    const other = await signedPublish({ seq: 4, key, builtAt: "2026-10-31T01:00:00.000Z" });
    await expect(admitRelayPublish(store, other.request, OPTS)).rejects.toThrow(/not newer/);
  });

  it("counts over-cap publishes but writes no objects for them", async () => {
    const { store, data } = memStore();
    const key = await generateSigningKeyPair();
    await admitRelayPublish(store, (await signedPublish({ seq: 1, key })).request, OPTS);
    await admitRelayPublish(store, (await signedPublish({ seq: 2, key })).request, OPTS);
    let err: (Error & { ops?: { writes: number } }) | null = null;
    try {
      await admitRelayPublish(store, (await signedPublish({ seq: 3, key })).request, OPTS);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.message).toMatch(/rate limit/);
    expect(err?.ops?.writes).toBe(0);
    const path = await publisherPath(encodeBase64(key.publicKey));
    const state = JSON.parse(data.get(`${path}/.state.json`)!.data);
    expect(state.windowCount).toBe(3);
    expect(JSON.parse(data.get(`${path}/objects/2/feed.json`)!.data).seq).toBe(2);
  });

  it("keeps ops bounded under a signed flood past the cap", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const key = await generateSigningKeyPair();
    for (let seq = 1; seq <= 20; seq += 1) {
      const { request } = await signedPublish({ seq, key });
      await admitRelayPublish(counted, request, { ...OPTS, maxPublishesPerWindow: 0 }).catch(() => {});
    }
    expect(ops.writes).toBe(0);
    expect(ops.reads).toBe(20);
    expect(ops.casAttempts).toBe(20);
  });
});

describe("serveRelayRead", () => {
  it("serves a signed fresh read once, then denies the replay inside the window", async () => {
    const { store } = memStore();
    const pub = await signedPublish({ seq: 1 });
    await admitRelayPublish(store, pub.request, OPTS);
    const path = await publisherPath(encodeBase64(pub.key.publicKey));
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const first = await serveRelayRead(store, req, { now: new Date(now + 1000) });
    expect(JSON.parse(first.manifest).seq).toBe(1);
    await expect(serveRelayRead(store, req, { now: new Date(now + 2000) })).rejects.toThrow(/already been used/);
    const req2 = await readRequest(reader, path, now + 3000, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    await expect(serveRelayRead(store, req2, { now: new Date(now + 4000) })).resolves.toBeTruthy();
  });

  it("rejects a stale timestamp before spending the nonce write", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const req = await readRequest(reader, "feeds/abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst", Date.parse("2026-10-31T00:00:00Z"), "n1");
    await expect(serveRelayRead(counted, req, { now: new Date("2026-10-31T01:00:00Z") })).rejects.toThrow(/too old/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
  });

  it("rejects a bad read signature with zero store ops", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const req = await readRequest(reader, "feeds/abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst", Date.parse("2026-10-31T00:00:00Z"), "n2");
    req.feedPath = "feeds/zzzzzzzzzzzzzzzzzzzzzzzzzz22222222222222222222222222";
    await expect(serveRelayRead(counted, req, { now: new Date("2026-10-31T00:00:30Z") })).rejects.toThrow(/signature/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
  });

  it("rejects an oversized nonce before any store op", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const req = {
      pubkey: encodeBase64(reader.publicKey),
      feedPath: "feeds/abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
      ts: now,
      nonce: "n".repeat(RELAY_MAX_NONCE_CHARS + 1),
      signature: "whatever",
    };
    await expect(serveRelayRead(counted, req, { now: new Date(now + 1000) })).rejects.toThrow(/damaged/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
  });

  it("refuses to serve a feed whose first publish never committed", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const path = await publisherPath(encodeBase64(key.publicKey));
    await store.putObject(`${path}/.state.json`, JSON.stringify({
      lastSeq: 9, windowStartMs: 0, windowCount: 1, manifestSha: "x", committed: false,
    }));
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    await expect(serveRelayRead(store, req, { now: new Date(now + 1000) })).rejects.toThrow(/not on the relay/);
  });

  it("serves the last committed feed while a newer publish is pending", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const path = await publisherPath(encodeBase64(key.publicKey));
    await admitRelayPublish(store, (await signedPublish({ seq: 1, key })).request, OPTS);
    // seq 2 claims but never commits (stalled mid-commit).
    await store.putObject(`${path}/.state.json`, JSON.stringify({
      lastSeq: 2, windowStartMs: OPTS.now.getTime(), windowCount: 2, manifestSha: "pending",
      committed: false, current: "objects/1/feed.json",
    }));
    const reader = await generateSigningKeyPair();
    const now = OPTS.now.getTime() + 1000;
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const served = await serveRelayRead(store, req, { now: new Date(now + 500) });
    expect(JSON.parse(served.manifest).seq).toBe(1);
  });

  it("keeps serving the committed feed after a crashed publish that is never resumed", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const path = await publisherPath(encodeBase64(key.publicKey));
    await admitRelayPublish(store, (await signedPublish({ seq: 3, key })).request, OPTS);
    await store.putObject(`${path}/.state.json`, JSON.stringify({
      lastSeq: 4, windowStartMs: OPTS.now.getTime(), windowCount: 2, manifestSha: "crashed",
      committed: false, current: "objects/3/feed.json",
    }));
    const reader = await generateSigningKeyPair();
    const now = OPTS.now.getTime() + 60_000;
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const served = await serveRelayRead(store, req, { now: new Date(now + 500) });
    expect(JSON.parse(served.manifest).seq).toBe(3);
  });

  it("keeps the feed readable after an over-cap denial", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const path = await publisherPath(encodeBase64(key.publicKey));
    await admitRelayPublish(store, (await signedPublish({ seq: 1, key })).request, OPTS);
    await admitRelayPublish(store, (await signedPublish({ seq: 2, key })).request, OPTS);
    await admitRelayPublish(store, (await signedPublish({ seq: 3, key })).request, OPTS).catch(() => {});
    const reader = await generateSigningKeyPair();
    const now = OPTS.now.getTime() + 1000;
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const served = await serveRelayRead(store, req, { now: new Date(now + 500) });
    expect(JSON.parse(served.manifest).seq).toBe(2);
  });
});

describe("serveRelayChunk", () => {
  it("serves a chunk of the current seq under the nonce gate and denies its replay", async () => {
    const { store } = memStore();
    const pub = await signedPublish({ seq: 1 });
    await admitRelayPublish(store, pub.request, OPTS);
    const path = await publisherPath(encodeBase64(pub.key.publicKey));
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const nonce = encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const req = {
      pubkey: encodeBase64(reader.publicKey),
      feedPath: path,
      chunkId: "chat-peer.json",
      ts: now,
      nonce,
      signature: await signRelayRead(reader.secretKey, { feedPath: `${path}/chunks/chat-peer.json`, ts: now, nonce }),
    };
    const first = await serveRelayChunk(store, req, { now: new Date(now + 1000) });
    expect(first.chunk).toContain("eic-feed-chunk");
    await expect(serveRelayChunk(store, req, { now: new Date(now + 2000) })).rejects.toThrow(/already been used/);
  });

  it("rejects a manifest-read signature replayed against a chunk path", async () => {
    const { store } = memStore();
    const pub = await signedPublish({ seq: 1 });
    await admitRelayPublish(store, pub.request, OPTS);
    const path = await publisherPath(encodeBase64(pub.key.publicKey));
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const nonce = encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const req = {
      pubkey: encodeBase64(reader.publicKey),
      feedPath: path,
      chunkId: "chat-peer.json",
      ts: now,
      nonce,
      signature: await signRelayRead(reader.secretKey, { feedPath: path, ts: now, nonce }),
    };
    await expect(serveRelayChunk(store, req, { now: new Date(now + 1000) })).rejects.toThrow(/signature/);
  });

  it("rejects a path-unsafe chunk id before any store op", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const req = {
      pubkey: encodeBase64(reader.publicKey),
      feedPath: "feeds/abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
      chunkId: "../.state.json",
      ts: now,
      nonce: "n",
      signature: "whatever",
    };
    await expect(serveRelayChunk(counted, req, { now: new Date(now + 1000) })).rejects.toThrow(/damaged/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 });
  });
});

describe("sweepExpiredNonces", () => {
  it("deletes expired nonces in bounded batches with a cursor, all ops accounted", async () => {
    const { store } = memStore();
    const old = Date.parse("2026-10-31T00:00:00Z");
    for (let i = 0; i < 5; i += 1) await store.putObject(`replay/r/n${i}`, String(old));
    const first = await sweepExpiredNonces(store, new Date(old + 6 * 60_000), { batch: 2 });
    expect(first.scanned).toBe(2);
    expect(first.deleted).toBe(2);
    expect(first.nextCursor).toBe("replay/r/n1");
    expect(first.ops.lists).toBe(1);
    expect(first.ops.reads).toBe(2);
    expect(first.ops.deletes).toBe(2);
    const second = await sweepExpiredNonces(store, new Date(old + 6 * 60_000), { batch: 2, cursor: first.nextCursor });
    expect(second.scanned).toBe(2);
    const third = await sweepExpiredNonces(store, new Date(old + 6 * 60_000), { batch: 2, cursor: second.nextCursor });
    expect(third.nextCursor).toBeUndefined();
    expect((await store.list("replay/", {})).keys).toEqual([]);
  });

  it("keeps fresh nonces", async () => {
    const { store } = memStore();
    const old = Date.parse("2026-10-31T00:00:00Z");
    await store.putObject("replay/r/old", String(old));
    await store.putObject("replay/r/fresh", String(old + 4 * 60_000));
    const result = await sweepExpiredNonces(store, new Date(old + 6 * 60_000));
    expect(result.deleted).toBe(1);
    expect(await store.get("replay/r/fresh")).not.toBeNull();
  });
});
