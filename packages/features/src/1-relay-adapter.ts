import { AppError, VaultCorruptError } from "@veil/core";
import { signPayload, verifySignature } from "@veil/crypto";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { verifyRelayPublish, type RelayPublishRequest } from "./chat-relay";

// Relay endpoint core (proposal; nothing deployed or wired). Host-neutral: the caller
// supplies an atomic store with compare-and-set semantics and owns the transport. The
// GCS binding maps compareAndSet onto object generation-match preconditions
// (ifGenerationMatch / ifGenerationMatch=0 for create-only), and putObject onto plain
// object writes. A Netlify Function (or any other front) adapts HTTP to these calls.
//
// Endpoint rules beyond chat-relay.ts's pure verification:
//  - Admission state per publisher key is ONE object mutated only through CAS, so the
//    monotonic sequence check (rollback rejection) and the rate counter are enforced
//    atomically. A stale-seq publish and an over-cap publish both lose the CAS race.
//  - The rate counter increments for every VALIDLY-SIGNED request, including denied
//    over-cap ones: a flood of signed requests still costs its counter reads and is
//    visible in accounting. Invalid signatures reject before any store call (zero ops).
//  - CAS retries are bounded (RELAY_MAX_CAS_RETRIES) so contention cannot amplify
//    store operations without limit.
//  - Signed reads are replay-proof: the reader's nonce must be stored create-only
//    before serving. A timestamp window alone is NOT replay protection and is only
//    used to reject stale requests before spending the nonce write.
//  - Commit ordering: chunks are written before feed.json, so readers never see a
//    manifest pointing at chunks that are not there yet.
//
// Retention/ceiling note: age-based lifecycle deletion is asynchronous and soft-delete
// state is a bucket config decision - neither is a strict storage ceiling, and no
// zero-bill claim is made anywhere in this design.

export const RELAY_MAX_CAS_RETRIES = 3;
export const RELAY_READ_MAX_AGE_MS = 5 * 60 * 1000;

export interface StoreEntry {
  data: string;
  generation: string;
}

export interface RelayAtomicStore {
  get(path: string): Promise<StoreEntry | null>;
  /**
   * Atomic compare-and-set. { createOnly: true } succeeds only if the path is absent
   * (GCS ifGenerationMatch=0); { generation } succeeds only if the current generation
   * matches (GCS ifGenerationMatch=<gen>). Returns false on precondition failure.
   */
  compareAndSet(
    path: string,
    data: string,
    cond: { createOnly: true } | { generation: string },
  ): Promise<boolean>;
  putObject(path: string, data: string): Promise<void>;
}

/** Store-operation accounting, returned with every admission result. */
export interface RelayOps {
  reads: number;
  casAttempts: number;
  writes: number;
}

export function countingStore(store: RelayAtomicStore): { store: RelayAtomicStore; ops: RelayOps } {
  const ops: RelayOps = { reads: 0, casAttempts: 0, writes: 0 };
  return {
    ops,
    store: {
      async get(path) {
        ops.reads += 1;
        return store.get(path);
      },
      async compareAndSet(path, data, cond) {
        ops.casAttempts += 1;
        return store.compareAndSet(path, data, cond);
      },
      async putObject(path, data) {
        ops.writes += 1;
        return store.putObject(path, data);
      },
    },
  };
}

interface PublisherState {
  lastSeq: number;
  windowStartMs: number;
  windowCount: number;
}

export interface RelayAdmissionOptions {
  allowlist?: string[];
  maxPublishesPerWindow: number;
  windowMs: number;
  now: Date;
}

export interface RelayAdmissionResult {
  publisherPath: string;
  ops: RelayOps;
}

/**
 * Verifies and admits a publish: signature check (no store ops on failure), then a
 * bounded CAS loop over the publisher's single state object enforcing monotonic seq
 * and the rate window atomically. On admission, chunk objects are written before the
 * manifest. Denied over-cap requests still increment the counter (counted flood).
 */
export async function admitRelayPublish(
  rawStore: RelayAtomicStore,
  request: RelayPublishRequest,
  opts: RelayAdmissionOptions,
): Promise<RelayAdmissionResult> {
  // Pure verification first: an invalid signature never touches the store.
  const verified = await verifyRelayPublish(request, { allowlist: opts.allowlist });
  const { store, ops } = countingStore(rawStore);
  const statePath = `${verified.publisherPath}/.state.json`;
  const nowMs = opts.now.getTime();

  let admitted: PublisherState | null = null;
  for (let attempt = 0; attempt <= RELAY_MAX_CAS_RETRIES; attempt += 1) {
    const entry = await store.get(statePath);
    const prev: PublisherState = entry
      ? JSON.parse(entry.data)
      : { lastSeq: 0, windowStartMs: nowMs, windowCount: 0 };
    if (!(verified.seq > prev.lastSeq)) {
      throw new AppError("That publish is not newer than the feed the relay already holds.");
    }
    const inWindow = nowMs - prev.windowStartMs < opts.windowMs;
    const next: PublisherState = {
      lastSeq: verified.seq,
      windowStartMs: inWindow ? prev.windowStartMs : nowMs,
      windowCount: (inWindow ? prev.windowCount : 0) + 1,
    };
    const data = JSON.stringify(next);
    const ok = entry
      ? await store.compareAndSet(statePath, data, { generation: entry.generation })
      : await store.compareAndSet(statePath, data, { createOnly: true });
    if (!ok) continue; // lost the race; bounded retries only
    admitted = next;
    // The counter increment above is committed BEFORE the cap check on purpose:
    // a validly-signed over-cap request is still accounted and still costs its ops.
    if (next.windowCount > opts.maxPublishesPerWindow) {
      const err = new AppError("That publisher is over the relay's rate limit.");
      (err as AppError & { ops?: RelayOps }).ops = ops;
      throw err;
    }
    break;
  }
  if (!admitted) {
    const err = new AppError("The relay is busy; try the publish again.");
    (err as AppError & { ops?: RelayOps }).ops = ops;
    throw err;
  }

  // Commit ordering: chunks first, manifest last.
  for (const file of verified.files) {
    if (file.path === "feed.json") continue;
    await store.putObject(`${verified.publisherPath}/${file.path}`, file.text);
  }
  const manifest = verified.files.find((f) => f.path === "feed.json");
  if (!manifest) throw new VaultCorruptError("That publish request is missing its manifest.");
  await store.putObject(`${verified.publisherPath}/feed.json`, manifest.text);
  return { publisherPath: verified.publisherPath, ops };
}

export interface RelayReadRequest {
  /** Reader's base64 pubkey; must be on the allowlist when one is configured. */
  pubkey: string;
  /** Publisher path to read, e.g. feeds/<base32(sha256(publisher pubkey))>. */
  feedPath: string;
  /** Milliseconds since epoch, signed. A freshness hint only - NOT replay protection. */
  ts: number;
  /** Single-use random nonce (base64), signed. */
  nonce: string;
  /** Signature over `${feedPath}:${ts}:${nonce}` with the reader's secret key. */
  signature: string;
}

export async function signRelayRead(
  secretKey: Uint8Array,
  read: { feedPath: string; ts: number; nonce: string },
): Promise<string> {
  const payload = new TextEncoder().encode(`${read.feedPath}:${read.ts}:${read.nonce}`);
  return encodeBase64(await signPayload(secretKey, payload));
}

/**
 * Verifies a signed read and serves the manifest. Order: signature check (no store ops
 * on failure), stale-timestamp rejection (cheap pre-filter, not replay protection),
 * then the nonce must be stored create-only - a replayed nonce loses and is denied
 * even inside the timestamp window.
 */
export async function serveRelayRead(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest,
  opts: { allowlist?: string[]; now: Date },
): Promise<{ manifest: string; ops: RelayOps }> {
  if (opts.allowlist && !opts.allowlist.includes(request.pubkey)) {
    throw new AppError("That reader key is not on the allowlist.");
  }
  const payload = new TextEncoder().encode(`${request.feedPath}:${request.ts}:${request.nonce}`);
  const ok = await verifySignature(
    decodeBase64(request.pubkey),
    payload,
    decodeBase64(request.signature),
  );
  if (!ok) throw new VaultCorruptError("That read request's signature does not check out.");
  if (Math.abs(opts.now.getTime() - request.ts) > RELAY_READ_MAX_AGE_MS) {
    throw new AppError("That read request is too old.");
  }
  const { store, ops } = countingStore(rawStore);
  const readerDigest = await globalThis.crypto.subtle.digest("SHA-256", decodeBase64(request.pubkey));
  const nonceKey = `replay/${encodeBase64(new Uint8Array(readerDigest))}/${request.nonce}`;
  const fresh = await store.compareAndSet(nonceKey, String(opts.now.getTime()), { createOnly: true });
  if (!fresh) throw new AppError("That read request has already been used.");
  const entry = await store.get(`${request.feedPath}/feed.json`);
  if (!entry) throw new AppError("That feed is not on the relay.");
  return { manifest: entry.data, ops };
}
