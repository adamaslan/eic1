import { AppError, VaultCorruptError } from "@veil/core";
import { signPayload, verifySignature } from "@veil/crypto";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { CHUNK_ID_PATTERN, verifyRelayPublish, type RelayPublishRequest } from "./chat-relay";

// Relay endpoint core (proposal; nothing deployed or wired). Host-neutral: the caller
// supplies an atomic store with compare-and-set semantics and owns the transport. The
// GCS binding maps compareAndSet onto object generation-match preconditions
// (ifGenerationMatch / ifGenerationMatch=0 for create-only), and putObject onto plain
// object writes. A Netlify Function (or any other front) adapts HTTP to these calls.
//
// Endpoint rules beyond chat-relay.ts's pure verification:
//  - Admission state per publisher key is ONE object mutated only through CAS, so the
//    monotonic sequence check (rollback rejection) and the rate counter commit
//    atomically. compareAndSet returns the NEW generation, and the commit flip is
//    guarded by the claim generation: if a newer publish claims the state while an
//    older one is mid-commit, the older publish's flip fails and its objects are
//    orphaned - never served. There is no unconditional write on the read path.
//  - Published objects are immutable and seq-keyed (objects/<seq>/...). The state
//    object is the versioned pointer: readers only ever follow a committed
//    `current` path out of a committed state, so a stale in-flight publish cannot
//    overwrite a newer feed.
//  - Idempotent commit: a same-seq + same-manifestSha retry after a mid-commit crash
//    resumes; a same-seq + different-manifest retry is a rejected rollback attempt.
//  - The rate counter increments for every VALIDLY-SIGNED claim, including denied
//    over-cap ones. Invalid signatures reject before any store call (zero ops).
//  - CAS retries are bounded (RELAY_MAX_CAS_RETRIES) against operation amplification.
//  - Signed reads are replay-proof per OBJECT: the client contract is a FRESH nonce
//    for every individual object request (manifest and each chunk). The timestamp
//    window is only a cheap pre-filter, never replay protection by itself.
//  - Chunk ids share one schema with admission (CHUNK_ID_PATTERN from chat-relay.ts).
//  - Nonce cleanup is the host-scheduled sweepExpiredNonces below: bounded batches
//    with a cursor, all ops accounted. A bucket lifecycle rule (>=
//    RELAY_READ_MAX_AGE_MS) is owner-approved backstop config, not the mechanism.
//
// Retention/ceiling note: age-based lifecycle deletion is asynchronous and soft-delete
// state is a bucket config decision - neither is a strict storage ceiling, and no
// zero-bill claim is made anywhere in this design.

export const RELAY_MAX_CAS_RETRIES = 3;
export const RELAY_READ_MAX_AGE_MS = 5 * 60 * 1000;
export const RELAY_MAX_PUBKEY_CHARS = 128;
export const RELAY_MAX_NONCE_CHARS = 128;
export const RELAY_MAX_FEED_PATH_CHARS = 256;
export const RELAY_NONCE_SWEEP_BATCH = 100;

export interface StoreEntry {
  data: string;
  generation: string;
}

export interface ListPage {
  keys: string[];
  /** Present when more keys remain; pass back as `cursor` to continue. */
  nextCursor?: string;
}

export interface RelayAtomicStore {
  get(path: string): Promise<StoreEntry | null>;
  /**
   * Atomic compare-and-set. { createOnly: true } succeeds only if the path is absent
   * (GCS ifGenerationMatch=0); { generation } succeeds only if the current generation
   * matches (GCS ifGenerationMatch=<gen>). Returns the NEW generation on success,
   * null on precondition failure.
   */
  compareAndSet(
    path: string,
    data: string,
    cond: { createOnly: true } | { generation: string },
  ): Promise<string | null>;
  /** Unconditional write to an IMMUTABLE, seq-keyed path. Never used on read paths. */
  putObject(path: string, data: string): Promise<void>;
  /** Bounded prefix listing for nonce cleanup. */
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<ListPage>;
  delete(path: string): Promise<void>;
}

/** Store-operation accounting, returned with every endpoint call. */
export interface RelayOps {
  reads: number;
  casAttempts: number;
  writes: number;
  lists: number;
  deletes: number;
}

export function countingStore(store: RelayAtomicStore): { store: RelayAtomicStore; ops: RelayOps } {
  const ops: RelayOps = { reads: 0, casAttempts: 0, writes: 0, lists: 0, deletes: 0 };
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
      async list(prefix, listOpts) {
        ops.lists += 1;
        return store.list(prefix, listOpts);
      },
      async delete(path) {
        ops.deletes += 1;
        return store.delete(path);
      },
    },
  };
}

interface PublisherState {
  lastSeq: number;
  windowStartMs: number;
  windowCount: number;
  /** sha256 (base64) of the manifest admitted at lastSeq. */
  manifestSha: string;
  /** false between the seq-claiming CAS and the commit flip (crash window). */
  committed: boolean;
  /** Immutable manifest path readers follow; set only when committed. */
  current?: string;
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

async function manifestSha256(manifest: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest));
  return encodeBase64(new Uint8Array(digest));
}

/**
 * Verifies and admits a publish: signature check (no store ops on failure), then a
 * bounded CAS loop over the publisher's single state object enforcing monotonic seq
 * and the rate window atomically. Objects are written to immutable seq-keyed paths;
 * the commit flip is guarded by the claim generation, so a publish that loses a
 * mid-commit race to a newer seq can never overwrite or be served over the newer feed.
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

  let claim: { state: PublisherState; generation: string } | null = null;
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
      // A resume re-claims the same seq: the crashed attempt already counted it.
      windowCount: isResume ? prev.windowCount : (inWindow && prev ? prev.windowCount : 0) + 1,
      manifestSha,
      committed: false,
    };
    const newGeneration = entry
      ? await store.compareAndSet(statePath, JSON.stringify(next), { generation: entry.generation })
      : await store.compareAndSet(statePath, JSON.stringify(next), { createOnly: true });
    if (newGeneration === null) continue; // lost the race; bounded retries only
    claim = { state: next, generation: newGeneration };
    // The counter increment above is committed BEFORE the cap check on purpose:
    // a validly-signed over-cap request is still accounted and still costs its ops.
    if (next.windowCount > opts.maxPublishesPerWindow) {
      const err = new AppError("That publisher is over the relay's rate limit.");
      (err as AppError & { ops?: RelayOps }).ops = ops;
      throw err;
    }
    break;
  }
  if (!claim) {
    const err = new AppError("The relay is busy; try the publish again.");
    (err as AppError & { ops?: RelayOps }).ops = ops;
    throw err;
  }

  // Immutable, seq-keyed objects. Chunks first, manifest last within the seq dir.
  const objectBase = `${verified.publisherPath}/objects/${verified.seq}`;
  for (const file of verified.files) {
    if (file.path === "feed.json") continue;
    await store.putObject(`${objectBase}/${file.path}`, file.text);
  }
  const manifest = verified.files.find((f) => f.path === "feed.json");
  if (!manifest) throw new VaultCorruptError("That publish request is missing its manifest.");
  await store.putObject(`${objectBase}/feed.json`, manifest.text);

  // Commit flip, guarded by the CLAIM generation: if a newer publish claimed the
  // state while we wrote objects, this CAS fails and our objects stay orphaned -
  // the newer feed is never overwritten by ours, and readers never follow us.
  const done: PublisherState = { ...claim.state, committed: true, current: `objects/${verified.seq}/feed.json` };
  const flipped = await store.compareAndSet(statePath, JSON.stringify(done), { generation: claim.generation });
  if (flipped === null) {
    const err = new AppError("A newer publish superseded this one; publish again with a newer sequence.");
    (err as AppError & { ops?: RelayOps }).ops = ops;
    throw err;
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
  /** Single-use random nonce (base64), signed. Fresh per object - see signRelayRead. */
  nonce: string;
  /** Signature over `${objectPath}:${ts}:${nonce}` with the reader's secret key. */
  signature: string;
}

export async function signRelayRead(
  secretKey: Uint8Array,
  read: { feedPath: string; ts: number; nonce: string },
): Promise<string> {
  const payload = new TextEncoder().encode(`${read.feedPath}:${read.ts}:${read.nonce}`);
  return encodeBase64(await signPayload(secretKey, payload));
}

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

/**
 * Shared read gate: field limits, allowlist, signature, stale-timestamp pre-filter,
 * then a FRESH create-only nonce. The nonce key is scoped to the requested object
 * path, and the client contract is one fresh nonce per object request. Returns the
 * counted store and the publisher's committed state for the caller to follow.
 */
async function gateRelayRead(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest,
  objectPath: string,
  opts: { allowlist?: string[]; now: Date },
): Promise<{ store: RelayAtomicStore; ops: RelayOps; state: PublisherState }> {
  validateReadFields(request);
  if (opts.allowlist && !opts.allowlist.includes(request.pubkey)) {
    throw new AppError("That reader key is not on the allowlist.");
  }
  const payload = new TextEncoder().encode(`${objectPath}:${request.ts}:${request.nonce}`);
  const ok = await verifySignature(decodeBase64(request.pubkey), payload, decodeBase64(request.signature));
  if (!ok) throw new VaultCorruptError("That read request's signature does not check out.");
  if (Math.abs(opts.now.getTime() - request.ts) > RELAY_READ_MAX_AGE_MS) {
    throw new AppError("That read request is too old.");
  }
  const { store, ops } = countingStore(rawStore);
  const readerDigest = await globalThis.crypto.subtle.digest("SHA-256", decodeBase64(request.pubkey));
  const nonceKey = `replay/${encodeBase64(new Uint8Array(readerDigest))}/${encodeURIComponent(objectPath)}/${request.nonce}`;
  const fresh = await store.compareAndSet(nonceKey, String(opts.now.getTime()), { createOnly: true });
  if (fresh === null) throw new AppError("That read request has already been used.");
  const entry = await store.get(`${request.feedPath}/.state.json`);
  if (!entry) throw new AppError("That feed is not on the relay.");
  const state: PublisherState = JSON.parse(entry.data);
  if (!state.committed || !state.current) throw new AppError("That feed has not finished publishing.");
  return { store, ops, state };
}

/**
 * Serves the publisher's current committed manifest under the signed-nonce read gate.
 * Readers follow only the `current` pointer of a committed state, so an orphaned
 * mid-commit object is never served.
 */
export async function serveRelayRead(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest,
  opts: { allowlist?: string[]; now: Date },
): Promise<{ manifest: string; ops: RelayOps }> {
  const { store, ops, state } = await gateRelayRead(rawStore, request, request.feedPath, opts);
  const entry = await store.get(`${request.feedPath}/${state.current}`);
  if (!entry) throw new AppError("That feed is not on the relay.");
  return { manifest: entry.data, ops };
}

/**
 * Serves one chunk of the CURRENT committed seq under the same signed-nonce gate.
 * Chunk reads are authenticated, never public; the signature binds the chunk object
 * path so a manifest-read signature cannot be replayed against a chunk. Chunk ids
 * share admission's schema (CHUNK_ID_PATTERN).
 */
export async function serveRelayChunk(
  rawStore: RelayAtomicStore,
  request: RelayReadRequest & { chunkId: string },
  opts: { allowlist?: string[]; now: Date },
): Promise<{ chunk: string; ops: RelayOps }> {
  if (!CHUNK_ID_PATTERN.test(request.chunkId)) throw new VaultCorruptError("That read request is damaged.");
  const objectPath = `${request.feedPath}/chunks/${request.chunkId}`;
  const { store, ops, state } = await gateRelayRead(rawStore, request, objectPath, opts);
  const seqDir = state.current!.replace(/\/feed\.json$/, "");
  const entry = await store.get(`${request.feedPath}/${seqDir}/chunks/${request.chunkId}`);
  if (!entry) throw new AppError("That feed chunk is not on the relay.");
  return { chunk: entry.data, ops };
}

/**
 * Bounded nonce cleanup. Deletes up to `batch` expired nonce objects per call and
 * returns a cursor; the host schedules it until nextCursor is absent. All list/get/
 * delete ops are accounted. A bucket lifecycle rule (>= RELAY_READ_MAX_AGE_MS) is
 * owner-approved backstop config, not the mechanism that bounds nonce growth.
 */
export async function sweepExpiredNonces(
  rawStore: RelayAtomicStore,
  now: Date,
  opts?: { maxAgeMs?: number; batch?: number; cursor?: string },
): Promise<{ deleted: number; scanned: number; nextCursor?: string; ops: RelayOps }> {
  const maxAgeMs = opts?.maxAgeMs ?? RELAY_READ_MAX_AGE_MS;
  const batch = Math.max(1, Math.min(opts?.batch ?? RELAY_NONCE_SWEEP_BATCH, 1000));
  const { store, ops } = countingStore(rawStore);
  const page = await store.list("replay/", { cursor: opts?.cursor, limit: batch });
  let deleted = 0;
  for (const key of page.keys) {
    const entry = await store.get(key);
    if (!entry) continue;
    const ts = Number(entry.data);
    if (Number.isFinite(ts) && now.getTime() - ts > maxAgeMs) {
      await store.delete(key);
      deleted += 1;
    }
  }
  return { deleted, scanned: page.keys.length, nextCursor: page.nextCursor, ops };
}
