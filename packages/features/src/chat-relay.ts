import { AppError, VaultCorruptError, decodeBase64, encodeBase64, type Settings } from "@veil/core";
import { signPayload, verifySignature } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { listOutboundChatEnvelopes } from "./chat";
import { loadOrCreateShareIdentity } from "./sharing";
import {
  FEED_FORMAT,
  FEED_VERSION,
  FEED_MANIFEST_MAX_BYTES,
  FeedChunkRefSchema,
  FeedManifestSchema,
  parseFeedManifest,
  type FeedManifest,
  type FeedSnapshot,
  type FeedSnapshotFile,
} from "./feed";

// Chat-only relay (proposal; nothing deployed or wired). Two halves:
//  1. buildChatFeedSnapshot - publisher side: the signed feed manifest carrying ONLY sealed
//     chat chunks. Posts/profile are excluded so the plaintext-disclosure decision never
//     gates messaging; the existing pull reader applies chat chunks independently of the
//     other kinds, so readers need no changes.
//  2. verifyRelayPublish - relay endpoint side: the only write rule. A publish is accepted
//     when the manifest signature verifies against its embedded pubkey, the manifest
//     declares chat chunks only, every uploaded file is pinned by the manifest, and the
//     publisher path is bound to the key (sha256(pubkey)), so writes self-authenticate and
//     path squatting is impossible. No storage, network, host, or token here: the endpoint
//     adapter (Netlify Function + store, or a repo-backed commit) is a separate, gated step.

export const RELAY_MAX_FILES_PER_PUBLISH = 100;
export const RELAY_MAX_CHUNK_BYTES = 1024 * 1024;

async function sha256Base64(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return encodeBase64(new Uint8Array(digest));
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The relay path a publisher key owns: feeds/<base32(sha256(pubkey))>. */
export async function publisherPath(pubkeyBase64: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", decodeBase64(pubkeyBase64));
  return `feeds/${base32Lower(new Uint8Array(digest))}`;
}

export async function buildChatFeedSnapshot(
  vault: UnlockedVault,
  settings: Settings,
  deps: { now: Date; seq: number },
): Promise<FeedSnapshot> {
  if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle before publishing.");
  if (!settings.feedUrl) throw new AppError("Set a feed URL before publishing.");
  if (!Number.isInteger(deps.seq) || deps.seq < 1) throw new AppError("The feed sequence must be a positive integer.");

  const identity = await loadOrCreateShareIdentity(vault);
  const files: FeedSnapshotFile[] = [];
  const chunks: FeedManifest["chunks"] = [];

  const outbound = await listOutboundChatEnvelopes(vault);
  for (const [recipientId, envelopes] of [...outbound.entries()].sort()) {
    const chunk = { format: "eic-feed-chunk", version: 1, kind: "chat", envelopes } as const;
    const id = `chat-${recipientId}.json`;
    const text = JSON.stringify(chunk);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > RELAY_MAX_CHUNK_BYTES) throw new AppError("The chat backlog is too large to publish in one chunk.");
    files.push({ path: `chunks/${id}`, text });
    chunks.push({ id, kind: "chat", bytes, sha256: await sha256Base64(text) });
  }

  const unsigned = {
    format: FEED_FORMAT,
    version: FEED_VERSION,
    authorId: settings.authorId,
    feedUrl: settings.feedUrl,
    pubkey: encodeBase64(identity.publicKey),
    seq: deps.seq,
    builtAt: deps.now.toISOString(),
    chunks,
  } as const;
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const manifest = JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
  if (new TextEncoder().encode(manifest).byteLength >= FEED_MANIFEST_MAX_BYTES) {
    throw new AppError("The feed manifest is too large.");
  }
  return { manifest, files: [{ path: "feed.json", text: manifest }, ...files] };
}

export interface RelayPublishRequest {
  manifest: string;
  files: FeedSnapshotFile[];
}

export interface VerifiedRelayPublish {
  publisherPath: string;
  seq: number;
  /** Files to store, keyed by their path RELATIVE to the publisher path (feed.json, chunks/<id>). */
  files: FeedSnapshotFile[];
}

/**
 * Verifies a publish request against the relay's only write rule. allowlist (base64 pubkeys)
 * is the proposed admission control: when provided, only listed publisher keys may write.
 * Pure verification - the caller owns storage and rate limiting.
 */
export async function verifyRelayPublish(
  request: RelayPublishRequest,
  opts?: { allowlist?: string[] },
): Promise<VerifiedRelayPublish> {
  if (!request || typeof request.manifest !== "string" || !Array.isArray(request.files)) {
    throw new VaultCorruptError("That publish request is damaged.");
  }
  if (request.files.length > RELAY_MAX_FILES_PER_PUBLISH) {
    throw new VaultCorruptError("That publish request has too many files.");
  }
  const manifest = parseFeedManifest(request.manifest);

  // Signature must verify against the manifest's own embedded pubkey: writes self-authenticate.
  {
    const { signature, ...unsigned } = manifest;
    const ok = await verifySignature(
      decodeBase64(manifest.pubkey),
      new TextEncoder().encode(JSON.stringify(unsigned)),
      decodeBase64(signature),
    );
    if (!ok) throw new VaultCorruptError("That feed manifest's signature does not check out.");
  }
  if (opts?.allowlist && !opts.allowlist.includes(manifest.pubkey)) {
    throw new AppError("That publisher key is not on the allowlist.");
  }

  // Chat-only relay: any posts/likes/profile chunk would re-open the plaintext-disclosure
  // decision, so it is rejected rather than stored.
  for (const ref of manifest.chunks) {
    if (ref.kind !== "chat") throw new VaultCorruptError("The chat relay does not store posts, likes, or profile chunks.");
    if (ref.bytes > RELAY_MAX_CHUNK_BYTES) throw new VaultCorruptError("That feed chunk is too large.");
  }

  // Every uploaded file must be feed.json or a manifest-pinned chunk with matching bytes+hash.
  // No extra files, no missing chunks, no path games.
  const allowedPaths = new Set<string>(["feed.json"]);
  const byId = new Map(manifest.chunks.map((c) => [`chunks/${c.id}`, c]));
  for (const path of byId.keys()) allowedPaths.add(path);
  const seen = new Set<string>();
  for (const file of request.files) {
    if (!allowedPaths.has(file.path) || seen.has(file.path)) {
      throw new VaultCorruptError("That publish request contains a file the manifest does not pin.");
    }
    seen.add(file.path);
    if (file.path === "feed.json") {
      if (file.text !== request.manifest) throw new VaultCorruptError("The uploaded feed.json does not match the manifest.");
      continue;
    }
    const ref = byId.get(file.path);
    if (!ref) throw new VaultCorruptError("That publish request contains a file the manifest does not pin.");
    const bytes = new TextEncoder().encode(file.text).byteLength;
    if (bytes !== ref.bytes || (await sha256Base64(file.text)) !== ref.sha256) {
      throw new VaultCorruptError("That feed chunk does not match the signed manifest.");
    }
  }
  if (seen.size !== allowedPaths.size) {
    throw new VaultCorruptError("That publish request is missing files the manifest pins.");
  }

  return { publisherPath: await publisherPath(manifest.pubkey), seq: manifest.seq, files: request.files };
}
