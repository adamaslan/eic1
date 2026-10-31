import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import {
  admitRelayPublish,
  countingStore,
  serveRelayRead,
  signRelayRead,
  RELAY_MAX_CAS_RETRIES,
  type RelayAtomicStore,
  type StoreEntry,
} from "./relay-adapter";
import { publisherPath } from "./chat-relay";
import { FEED_FORMAT, FEED_VERSION } from "./feed";

/** In-memory store with genuinely atomic CAS (check+set happen in one synchronous step). */
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
        if (cur) return false;
      } else if (!cur || cur.generation !== cond.generation) {
        return false;
      }
      gen += 1;
      data.set(path, { data: text, generation: `g${gen}` });
      return true;
    },
    async putObject(path, text) {
      gen += 1;
      data.set(path, { data: text, generation: `g${gen}` });
    },
  };
  return { store, data };
}

async function signedPublish(opts: { seq: number; key?: Awaited<ReturnType<typeof generateSigningKeyPair>> }) {
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
    builtAt: new Date("2026-10-31T00:00:00Z").toISOString(),
    chunks: [{ id: "chat-peer.json", kind: "chat", bytes: new TextEncoder().encode(chunk).byteLength, sha256: encodeBase64(new Uint8Array(digest)) }],
  };
  const signature = await signPayload(key.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const manifest = JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
  return { key, request: { manifest, files: [{ path: "feed.json", text: manifest }, { path: "chunks/chat-peer.json", text: chunk }] } };
}

const OPTS = { maxPublishesPerWindow: 2, windowMs: 60_000, now: new Date("2026-10-31T00:00:00Z") };

describe("admitRelayPublish", () => {
  it("admits a valid publish, writes chunks before the manifest, and records ops", async () => {
    const { store, data } = memStore();
    const { key, request } = await signedPublish({ seq: 1 });
    const result = await admitRelayPublish(store, request, OPTS);
    expect(result.publisherPath).toBe(await publisherPath(encodeBase64(key.publicKey)));
    expect(data.has(`${result.publisherPath}/feed.json`)).toBe(true);
    expect(data.has(`${result.publisherPath}/chunks/chat-peer.json`)).toBe(true);
    expect(result.ops.reads).toBe(1);
    expect(result.ops.writes).toBe(2);
  });

  it("rejects an invalid signature before any store operation", async () => {
    const { store } = memStore();
    const { request } = await signedPublish({ seq: 1 });
    const { store: counted, ops } = countingStore(store);
    await expect(
      admitRelayPublish(counted, { manifest: request.manifest.replace('"seq":1', '"seq":9'), files: request.files }, OPTS),
    ).rejects.toThrow(/signature/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0 });
  });

  it("resolves a concurrent same-seq publish race: exactly one wins, the other is denied", async () => {
    // Barrier makes both publishers read the state before either CAS lands.
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
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const denied = results.find((r) => r.status === "rejected");
    expect((denied as PromiseRejectedResult).reason.message).toMatch(/not newer/);
  });

  it("rejects a rollback (older seq) even after a successful publish", async () => {
    const { store } = memStore();
    const key = await generateSigningKeyPair();
    const newer = await signedPublish({ seq: 7, key });
    const older = await signedPublish({ seq: 3, key });
    await admitRelayPublish(store, newer.request, OPTS);
    await expect(admitRelayPublish(store, older.request, OPTS)).rejects.toThrow(/not newer/);
  });

  it("counts over-cap publishes but writes no objects for them", async () => {
    const { store, data } = memStore();
    const key = await generateSigningKeyPair();
    await admitRelayPublish(store, (await signedPublish({ seq: 1, key })).request, OPTS);
    await admitRelayPublish(store, (await signedPublish({ seq: 2, key })).request, OPTS);
    let err: (Error & { ops?: { reads: number; casAttempts: number; writes: number } }) | null = null;
    try {
      await admitRelayPublish(store, (await signedPublish({ seq: 3, key })).request, OPTS);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.message).toMatch(/rate limit/);
    // The denied request was still counted: windowCount reached 3, ops were spent.
    expect(err?.ops?.reads).toBeGreaterThanOrEqual(1);
    expect(err?.ops?.casAttempts).toBeGreaterThanOrEqual(1);
    const path = await publisherPath(encodeBase64(key.publicKey));
    const state = JSON.parse(data.get(`${path}/.state.json`)!.data);
    expect(state.windowCount).toBe(3);
    // Manifest on the relay is still seq 2's; the denied publish wrote nothing.
    expect(JSON.parse(data.get(`${path}/feed.json`)!.data).seq).toBe(2);
  });

  it("keeps ops bounded under a signed flood past the cap", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const key = await generateSigningKeyPair();
    for (let seq = 1; seq <= 20; seq += 1) {
      const { request } = await signedPublish({ seq, key });
      await admitRelayPublish(counted, request, { ...OPTS, maxPublishesPerWindow: 0 }).catch(() => {});
    }
    // Each flood request: bounded reads and CAS attempts, zero object writes.
    expect(ops.writes).toBe(0);
    expect(ops.reads).toBeLessThanOrEqual(20 * (RELAY_MAX_CAS_RETRIES + 1));
    expect(ops.casAttempts).toBeLessThanOrEqual(20 * (RELAY_MAX_CAS_RETRIES + 1));
    expect(ops.reads).toBe(20); // first CAS attempt always succeeds with no contention
  });
});

describe("serveRelayRead", () => {
  async function readRequest(key: Awaited<ReturnType<typeof generateSigningKeyPair>>, feedPath: string, ts: number, nonce: string) {
    return {
      pubkey: encodeBase64(key.publicKey),
      feedPath,
      ts,
      nonce,
      signature: await signRelayRead(key.secretKey, { feedPath, ts, nonce }),
    };
  }

  it("serves a signed fresh read once, then denies the replay inside the timestamp window", async () => {
    const { store, data } = memStore();
    const pub = await signedPublish({ seq: 1 });
    await admitRelayPublish(store, pub.request, OPTS);
    const path = await publisherPath(encodeBase64(pub.key.publicKey));
    const reader = await generateSigningKeyPair();
    const now = Date.parse("2026-10-31T00:00:30Z");
    const req = await readRequest(reader, path, now, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    const first = await serveRelayRead(store, req, { now: new Date(now + 1000) });
    expect(JSON.parse(first.manifest).seq).toBe(1);
    // Replay: same nonce, still inside the 5-minute window - must be denied.
    await expect(serveRelayRead(store, req, { now: new Date(now + 2000) })).rejects.toThrow(/already been used/);
    // A new nonce from the same reader is fine.
    const req2 = await readRequest(reader, path, now + 3000, encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))));
    await expect(serveRelayRead(store, req2, { now: new Date(now + 4000) })).resolves.toBeTruthy();
    expect(data.has(`${path}/feed.json`)).toBe(true);
  });

  it("rejects a stale timestamp before spending the nonce write", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const req = await readRequest(reader, "feeds/abc", Date.parse("2026-10-31T00:00:00Z"), "n1");
    await expect(serveRelayRead(counted, req, { now: new Date("2026-10-31T01:00:00Z") })).rejects.toThrow(/too old/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0 });
  });

  it("rejects a bad read signature with zero store ops", async () => {
    const { store } = memStore();
    const { store: counted, ops } = countingStore(store);
    const reader = await generateSigningKeyPair();
    const req = await readRequest(reader, "feeds/abc", Date.parse("2026-10-31T00:00:00Z"), "n2");
    req.feedPath = "feeds/other"; // signature no longer covers the request
    await expect(serveRelayRead(counted, req, { now: new Date("2026-10-31T00:00:30Z") })).rejects.toThrow(/signature/);
    expect(ops).toEqual({ reads: 0, casAttempts: 0, writes: 0 });
  });
});
