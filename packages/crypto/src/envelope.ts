import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { AppError, decodeBase64, encodeBase64, type Bytes } from "@veil/core";
import { signPayload, verifySignature } from "./signing";

// eic-sync v1 envelopes (spec: docs/eic1-newest-todos-2026-10-30.md section 3). One encrypted,
// signed message between two author identities. Chat/posts/likes ride these inside published
// feeds; the transport never sees plaintext.
//
// Keys come from the eic-share v2 signed bundles: every author's Ed25519 identity doubles as
// their encryption identity through the standard edwards->montgomery conversion, so no extra
// key distribution is needed.

export const SYNC_FORMAT = "eic-sync";
export const SYNC_VERSION = 1;
export const SYNC_KINDS = ["chat", "posts", "likes"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export interface SyncEnvelope {
  format: typeof SYNC_FORMAT;
  version: typeof SYNC_VERSION;
  authorId: string;
  recipientAuthorId: string;
  kind: SyncKind;
  nonce: string; // base64, 24 bytes
  ciphertext: string; // base64
  signature: string; // base64 Ed25519 over the canonical unsigned envelope
}

const FIELD_P = (1n << 255n) - 19n;

function modInverse(a: bigint): bigint {
  // Fermat: p is prime, so a^(p-2) = a^-1 (mod p).
  let base = ((a % FIELD_P) + FIELD_P) % FIELD_P;
  let exp = FIELD_P - 2n;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % FIELD_P;
    base = (base * base) % FIELD_P;
    exp >>= 1n;
  }
  return result;
}

function bytesToNumberLE(bytes: Bytes): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

function numberToBytesLE(n: bigint, length: number): Bytes {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// Ed25519 public key -> X25519 public key: decode the edwards y coordinate, then
// u = (1 + y) / (1 - y) on the montgomery curve.
export function ed25519PublicKeyToX25519(publicKey: Bytes): Bytes {
  if (publicKey.length !== 32) throw new AppError("A signing public key must be 32 bytes.");
  const masked = new Uint8Array(publicKey);
  masked[31]! &= 0x7f; // strip the sign bit of x; only y feeds the map
  const y = bytesToNumberLE(masked);
  if (y >= FIELD_P) throw new AppError("The signing public key is malformed.");
  const u = (((1n + y) * modInverse(1n - y)) % FIELD_P + FIELD_P) % FIELD_P;
  return numberToBytesLE(u, 32);
}

// Ed25519 secret (PKCS8 as exported by Web Crypto) -> X25519 secret:
// extract the 32-byte seed, hash with SHA-512, clamp the first half.
export async function ed25519SecretKeyToX25519(secretKeyPkcs8: Bytes): Promise<Bytes> {
  // PKCS8 Ed25519: 16-byte fixed prefix then the 32-byte seed.
  const PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  if (secretKeyPkcs8.length !== PREFIX.length + 32 || !PREFIX.every((b, i) => secretKeyPkcs8[i] === b)) {
    throw new AppError("The signing secret key is not an Ed25519 PKCS8 key.");
  }
  const seed = secretKeyPkcs8.slice(PREFIX.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-512", seed as BufferSource));
  const scalar = digest.slice(0, 32);
  scalar[0]! &= 248;
  scalar[31]! &= 127;
  scalar[31]! |= 64;
  return scalar;
}

function canonicalUnsigned(envelope: Omit<SyncEnvelope, "signature">): Bytes {
  // Key order is fixed by this construction; JSON.stringify preserves insertion order.
  return new TextEncoder().encode(JSON.stringify(envelope));
}

async function sharedKey(
  mySigningSecret: Bytes,
  theirSigningPublic: Bytes,
): Promise<Bytes> {
  const mySecret = await ed25519SecretKeyToX25519(mySigningSecret);
  const theirPublic = ed25519PublicKeyToX25519(theirSigningPublic);
  const shared = x25519.getSharedSecret(mySecret, theirPublic);
  return hkdf(sha256, shared, undefined, new TextEncoder().encode("eic-sync-v1"), 32);
}

export interface SealArgs {
  secretKey: Bytes; // sender Ed25519 PKCS8
  authorId: string;
  recipientAuthorId: string;
  recipientPublicKey: Bytes; // recipient Ed25519 raw public key (from their signed bundle)
  kind: SyncKind;
  plaintext: Bytes;
}

export async function sealSyncEnvelope(args: SealArgs): Promise<SyncEnvelope> {
  if (!SYNC_KINDS.includes(args.kind)) throw new AppError("Unknown sync envelope kind.");
  const key = await sharedKey(args.secretKey, args.recipientPublicKey);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(args.plaintext);
  const unsigned: Omit<SyncEnvelope, "signature"> = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    authorId: args.authorId,
    recipientAuthorId: args.recipientAuthorId,
    kind: args.kind,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
  const signature = await signPayload(args.secretKey, canonicalUnsigned(unsigned));
  return { ...unsigned, signature: encodeBase64(signature) };
}

export interface OpenArgs {
  secretKey: Bytes; // recipient Ed25519 PKCS8
  authorId: string; // recipient's own author id - the envelope must be addressed to it
  authorPublicKey: Bytes; // sender Ed25519 raw public key (from their signed bundle)
  envelope: unknown;
}

export async function openSyncEnvelope(
  args: OpenArgs,
): Promise<{ authorId: string; kind: SyncKind; plaintext: Bytes }> {
  const e = args.envelope as Partial<SyncEnvelope> | null;
  if (!e || e.format !== SYNC_FORMAT) throw new AppError("Not an eic-sync envelope.");
  if (e.version !== SYNC_VERSION) throw new AppError("Unsupported eic-sync version.");
  if (typeof e.authorId !== "string" || typeof e.recipientAuthorId !== "string") {
    throw new AppError("The sync envelope is damaged.");
  }
  if (e.recipientAuthorId !== args.authorId) throw new AppError("This envelope is not addressed to this vault.");
  if (!e.kind || !SYNC_KINDS.includes(e.kind)) throw new AppError("Unknown sync envelope kind.");
  if (typeof e.nonce !== "string" || typeof e.ciphertext !== "string" || typeof e.signature !== "string") {
    throw new AppError("The sync envelope is damaged.");
  }
  let nonce: Bytes, ciphertext: Bytes, signature: Bytes;
  try {
    nonce = decodeBase64(e.nonce);
    ciphertext = decodeBase64(e.ciphertext);
    signature = decodeBase64(e.signature);
  } catch {
    throw new AppError("The sync envelope is damaged.");
  }
  if (nonce.length !== 24) throw new AppError("The sync envelope is damaged.");
  const unsigned: Omit<SyncEnvelope, "signature"> = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    authorId: e.authorId,
    recipientAuthorId: e.recipientAuthorId,
    kind: e.kind,
    nonce: e.nonce,
    ciphertext: e.ciphertext,
  };
  const verified = await verifySignature(args.authorPublicKey, canonicalUnsigned(unsigned), signature);
  if (!verified) throw new AppError("The sync envelope signature does not verify.");
  const key = await sharedKey(args.secretKey, args.authorPublicKey);
  let plaintext: Bytes;
  try {
    plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new AppError("The sync envelope could not be decrypted.");
  }
  return { authorId: e.authorId, kind: e.kind, plaintext };
}
