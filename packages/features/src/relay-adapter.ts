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
  /** Prefix listing, used only by nonce cleanup. */
  list(prefix: string): Promise<string[]>;
  delete(path: string): Promise<void>;
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
      list: (prefix) => store.list(prefix),
      delete: (path) => store.delete(path),
    },
  };
}

interface PublisherState {
  lastSeq: number;
  windowStartMs: number;
  windowCount: number;
  /** sha256 (base64) of the manifest admitted at lastSeq. */
  manifestSha: string;
  /** false between the seq-claiming CAS and the feed.json write (crash window). */
  committed: boolean;
}

export const RELAY_MAX_PUBKEY_CHARS = 128;
export const RELAY_MAX_NONCE_CHARS = 128;
export const RELAY_MAX_FEED_PATH_CHARS = 256;

async function manifestSha256(manifest: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest));
  return encodeBase64(new Uint8Array(digest));
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
  const manifestSha = await manifestSha256(request.manifest);

  // Idempotent commit: the state records committed=false when the seq is claimed and
  // flips to true only after feed.json lands. A retry with the SAME seq and the SAME
  // manifest hash after a mid-commit crash resumes the commit instead of being
  // rejected as "not newer"; a same-seq retry with a DIFFERENT manifest is a rollback
  // attempt and stays rejected. No silent message drop, no manual seq bump.
  let claimed = false;
  for (let attempt = 0; attempt <= RELAY_MAX_CAS_RETRIES; attempt += 1) {
    const entry = await store.get(statePath);
    const prev: PublisherState | null = entry ? JSON.parse(entry.data) : null;
    const isResume =
      prev !== null && prev.lastSeq === verified.seq && prev.manifestSha === manifestSha && !prev.committed;
    if (!isResume && prev !== null && !(verified.seq > prev.lastSeq)) {
      throw new AppError("That publish is not newer than the feed the relay already holds.");
    }
    const inWindow = prev !== null && nowMs - prev.windowStartMs < opts.windowMs;
    const next: PublisherState = {
      lastSeq: verified.seq,
      windowStartMs: inWindow && prev ? prev.windowStartMs : nowMs,
      // A resume re-claims the same seq: the counter was already incremented by the
      // crashed attempt, so it is not counted twice.
      windowCount: isResume ? prev.windowCount : ((inWindow && prev ? prev.windowCount : 0) + 1),
      manifestSha,
      committed: false,
    };
    const data = JSON.stringify(next);
    const ok = entry
      ? await store.compareAndSet(statePath, data, { generation: entry.generation })
      : await store.compareAndSet(statePath, data, { createOnly: true });
    if (!ok) continue; // lost the race; bounded retries only
    claimed = true;
    // The counter increment above is committed BEFORE the cap check on purpose:
    // a validly-signed over-cap request is still accounted and still costs its ops.
    if (next.windowCount > opts.maxPublishesPerWindow) {
      const err = new AppError("That publisher is over the relay's rate limit.");
      (err as AppError & { ops?: RelayOps }).ops = ops;
      throw err;
    }
    break;
  }
  if (!claimed) {
    const err = new AppError("The relay is busy; try the publish again.");
    (err as AppError & { ops?: RelayOps }).ops = ops;
    throw err;
  }

  // Commit ordering: chunks first, manifest last, committed flag final.
  for (const file of verified.files) {
    if (file.path === "feed.json") continue;
    await store.putObject(`${verified.publisherPath}/${file.path}`, file.text);
  }
  const manifest = verified.files.find((f) => f.path === "feed.json");
  if (!manifest) throw new VaultCorruptError("That publish request is missing its manifest.");
  await store.putObject(`${verified.publisherPath}/feed.json`, manifest.text);
  for (let attempt = 0; attempt <= RELAY_MAX_CAS_RETRIES; attempt += 1) {
    const entry = await store.get(statePath);
    if (!entry) break; // state vanished; objects are already committed
    const state: PublisherState = JSON.parse(entry.data);
    if (state.lastSeq !== verified.seq || state.manifestSha !== manifestSha) break; // a newer claim owns the state
    const done: PublisherState = { ...state, committed: true };
    if (await store.compareAndSet(statePath, JSON.stringify(done), { generation: entry.generation })) break;
  }
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
function validateReadFields(request: RelayReadRequest): void {
  if (typeof request.pubkey !== "string" || request.pubkey.length > RELAY_MAX_PUBKEY_CHARS) {
    throw new VaultCorruptError("That read request is damaged.");
  }
  if (typeof request.nonce !== "string" || request.nonce.length === 0 || request.nonce.length > RELAY_MAX_NONCE_CHARS) {
    throw new VaultCorruptError("That read request is damaged.");
  }
  if (
    typeof request.feedPath !== "string" ||
    !/^feeds\/[a-z2-7]{52}$/.test(request.feedPath) ||
    request.feedPath.length > RELAY_MAX_FEED_PATH_CHARS
  ) {
    throw new VaultCorruptError("That read request is damaged.");
  }
}

export async function serveRelayRead(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest,
  opts: { allowlist?: string[]; now: Date },
): Promise<{ manifest: string; ops: RelayOps }> {
  validateReadFields(request);
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

/** Chunk ids a manifest may pin: chat-<recipientId>.json, path-safe only. */
const CHUNK_ID_PATTERN = /^chat-[a-zA-Z0-9_-]{1,128}\.json$/;

/**
 * Serves one manifest-pinned chunk under the SAME signed-nonce rule as feed.json:
 * chunk reads are authenticated, never public. The signature binds
 * `${feedPath}/chunks/${chunkId}:${ts}:${nonce}` so a feed-manifest signature cannot
 * be replayed against a chunk path.
 */
export async function serveRelayChunk(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest & { chunkId: string },
  opts: { allowlist?: string[]; now: Date },
): Promise<{ chunk: string; ops: RelayOps }> {
  if (!CHUNK_ID_PATTERN.test(request.chunkId)) throw new VaultCorruptError("That read request is damaged.");
  const chunkPath = `${request.feedPath}/chunks/${request.chunkId}`;
  const signed: RelayReadRequest = { ...request, feedPath: chunkPath };
  validateReadFields({ ...signed, feedPath: request.feedPath });
  if (opts.allowlist && !opts.allowlist.includes(request.pubkey)) {
    throw new AppError("That reader key is not on the allowlist.");
  }
  const payload = new TextEncoder().encode(`${chunkPath}:${request.ts}:${request.nonce}`);
  const ok = await verifySignature(decodeBase64(request.pubkey), payload, decodeBase64(request.signature));
  if (!ok) throw new VaultCorruptError("That read request's signature does not check out.");
  if (Math.abs(opts.now.getTime() - request.ts) > RELAY_READ_MAX_AGE_MS) {
    throw new AppError("That read request is too old.");
  }
  const { store, ops } = countingStore(rawStore);
  const readerDigest = await globalThis.crypto.subtle.digest("SHA-256", decodeBase64(request.pubkey));
  const nonceKey = `replay/${encodeBase64(new Uint8Array(readerDigest))}/${request.nonce}`;
  const fresh = await store.compareAndSet(nonceKey, String(opts.now.getTime()), { createOnly: true });
  if (!fresh) throw new AppError("That read request has already been used.");
  const entry = await store.get(chunkPath);
  if (!entry) throw new AppError("That feed chunk is not on the relay.");
  return { chunk: entry.data, ops };
}

/**
 * Deletes nonce objects older than maxAgeMs. Nonce growth is bounded by THIS sweep,
 * which the host must run on a schedule; a bucket lifecycle rule (>=
 * RELAY_READ_MAX_AGE_MS, owner-approved bucket config) is the backstop, not the only
 * mechanism. Sweep ops are ordinary list/delete calls.
 */
export async function sweepExpiredNonces(
  store: RelayAtomicStore,
  now: Date,
  maxAgeMs: number = RELAY_READ_MAX_AGE_MS,
): Promise<{ deleted: number }> {
  const keys = await store.list("replay/");
  let deleted = 0;
  for (const key of keys) {
    const entry = await store.get(key);
    if (!entry) continue;
    const ts = Number(entry.data);
    if (Number.isFinite(ts) && now.getTime() - ts > maxAgeMs) {
      await store.delete(key);
      deleted += 1;
    }
  }
  return { deleted };
}
