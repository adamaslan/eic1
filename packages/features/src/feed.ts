import { z } from "zod";
import { AppError, VaultCorruptError, decodeBase64, encodeBase64, type Item, type Settings } from "@veil/core";
import { signPayload, verifySignature, type SyncEnvelope } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { buildShareBundle, loadOrCreateShareIdentity } from "./sharing";
import { listOutboundChatEnvelopes } from "./chat";

// eic-feed v1 (spec section 3): a signed manifest plus chunk files, published by each vault to a
// static URL and pulled by connections. Chunk payloads are ciphertext only: posts travel as a
// signed eic-share v2 bundle (shareable posts never include private ones) and chat travels as
// sealed eic-sync v1 envelopes. The publish target URL is a config value, not a format decision.

export const FEED_FORMAT = "eic-feed";
export const FEED_VERSION = 1;
export const FEED_MANIFEST_MAX_BYTES = 1024 * 1024;
export const FEED_CHUNK_MAX_BYTES = 25 * 1024 * 1024;

const CHUNK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const FEED_CHUNK_KINDS = ["posts", "likes", "chat"] as const;
export type FeedChunkKind = (typeof FEED_CHUNK_KINDS)[number];

// Kind is a plain string on the wire: manifests stay signed over their exact bytes, and
// readers skip chunk kinds they do not know instead of rejecting the whole manifest. That
// keeps older peers working when newer feeds add kinds (they still verify the manifest
// signature and the hash of every chunk they apply).
export const FeedChunkRefSchema = z.object({
  id: z.string().regex(CHUNK_ID),
  kind: z.string().min(1).max(40),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1), // base64 digest of the chunk file bytes
});

export const FeedManifestSchema = z.object({
  format: z.literal(FEED_FORMAT),
  version: z.literal(FEED_VERSION),
  authorId: z.string().min(1),
  feedUrl: z.string().min(1),
  pubkey: z.string().min(1),
  seq: z.number().int().positive(),
  builtAt: z.iso.datetime(),
  chunks: z.array(FeedChunkRefSchema).max(1000),
  signature: z.string().min(1),
});
export type FeedManifest = z.infer<typeof FeedManifestSchema>;

const FeedChatChunkSchema = z.object({
  format: z.literal("eic-feed-chunk"),
  version: z.literal(1),
  kind: z.literal("chat"),
  envelopes: z.array(z.unknown()).max(1000),
});

async function sha256Base64(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return encodeBase64(new Uint8Array(digest));
}

export function chunkUrl(feedUrl: string, chunkId: string): string {
  return `${feedUrl.replace(/\/+$/, "")}/chunks/${chunkId}`;
}

/** Feed URLs must be https (ciphertext hosts); plain http is allowed only for local development. */
export function isValidFeedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function manifestUrl(feedUrl: string): string {
  return `${feedUrl.replace(/\/+$/, "")}/feed.json`;
}

export interface FeedSnapshotFile {
  path: string;
  text: string;
}

export interface FeedSnapshot {
  manifest: string;
  files: FeedSnapshotFile[];
}

/**
 * Builds the feed files this vault publishes: a signed manifest, one posts/likes chunk (the
 * eic-share v2 bundle - the share gate keeps private posts out), and one chat chunk per
 * connection holding only sealed outbound envelopes. `seq` must increase on every publish.
 */
export async function buildFeedSnapshot(
  vault: UnlockedVault,
  settings: Settings,
  items: Item[],
  deps: { now: Date; seq: number },
): Promise<FeedSnapshot> {
  if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle before publishing a feed.");
  if (!settings.feedUrl) throw new AppError("Set a feed URL before publishing.");
  if (!Number.isInteger(deps.seq) || deps.seq < 1) throw new AppError("The feed sequence must be a positive integer.");

  const identity = await loadOrCreateShareIdentity(vault);
  const files: FeedSnapshotFile[] = [];
  const chunks: z.infer<typeof FeedChunkRefSchema>[] = [];

  const posts = { id: "posts.json", text: (await buildShareBundle(vault, settings, items, deps.now)).text };
  files.push({ path: chunkUrl("_", posts.id).slice(2), text: posts.text });
  chunks.push({
    id: posts.id,
    kind: "posts",
    bytes: new TextEncoder().encode(posts.text).byteLength,
    sha256: await sha256Base64(posts.text),
  });

  const outbound = await listOutboundChatEnvelopes(vault);
  for (const [recipientId, envelopes] of [...outbound.entries()].sort()) {
    const chunk = {
      format: "eic-feed-chunk",
      version: 1,
      kind: "chat",
      envelopes: envelopes as SyncEnvelope[],
    } as const;
    const id = `chat-${recipientId}.json`;
    const text = JSON.stringify(chunk);
    files.push({ path: `chunks/${id}`, text });
    chunks.push({ id, kind: "chat", bytes: new TextEncoder().encode(text).byteLength, sha256: await sha256Base64(text) });
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

export function parseFeedManifest(text: string): FeedManifest {
  if (new TextEncoder().encode(text).byteLength >= FEED_MANIFEST_MAX_BYTES) {
    throw new VaultCorruptError("That feed manifest is too large.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That feed manifest is damaged.");
  }
  const parsed = FeedManifestSchema.safeParse(json);
  if (!parsed.success) throw new VaultCorruptError("That feed manifest is damaged.");
  return parsed.data;
}

/** Verifies the manifest signature against the connection's pinned key. Fails closed. */
export async function verifyFeedManifest(manifest: FeedManifest, expectedAuthorId: string, pubkeyBase64: string): Promise<void> {
  if (manifest.authorId !== expectedAuthorId) {
    throw new VaultCorruptError("That feed belongs to someone else.");
  }
  if (manifest.pubkey !== pubkeyBase64) {
    throw new VaultCorruptError("That feed was signed with a different key than this connection's.");
  }
  const { signature, ...unsigned } = manifest;
  const ok = await verifySignature(
    decodeBase64(pubkeyBase64),
    new TextEncoder().encode(JSON.stringify(unsigned)),
    decodeBase64(signature),
  );
  if (!ok) throw new VaultCorruptError("That feed manifest's signature does not check out.");
}

export async function verifyFeedChunk(ref: z.infer<typeof FeedChunkRefSchema>, text: string): Promise<void> {
  if (new TextEncoder().encode(text).byteLength >= FEED_CHUNK_MAX_BYTES) {
    throw new VaultCorruptError("That feed chunk is too large.");
  }
  if ((await sha256Base64(text)) !== ref.sha256) {
    throw new VaultCorruptError("That feed chunk does not match the signed manifest.");
  }
}

/** Parses a chat chunk after its hash checked out. Envelopes are verified individually on apply. */
export function parseFeedChatChunk(text: string): unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That feed chunk is damaged.");
  }
  const parsed = FeedChatChunkSchema.safeParse(json);
  if (!parsed.success) throw new VaultCorruptError("That feed chunk is damaged.");
  return parsed.data.envelopes;
}
