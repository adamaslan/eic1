import {
  type Bytes,
  WrongPassphraseError,
  type CryptoPort,
  type VaultKey,
  type VaultMeta,
} from "@veil/core";

// OWASP's PBKDF2-HMAC-SHA256 guidance. Stored in each vault's meta, so it can
// be raised later without breaking existing vaults.
export const KDF_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const GENERATION_BYTES = 16;
const IV_BYTES = 12;
const VERIFIER_PLAINTEXT = new TextEncoder().encode("veil-vault-verifier-v1");

export interface SealedBytes {
  iv: Bytes;
  ciphertext: Bytes;
}

export interface NewVault {
  meta: VaultMeta;
  key: VaultKey;
}

export async function createVaultMeta(
  crypto: CryptoPort,
  passphrase: string,
  now: Date,
): Promise<NewVault> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await crypto.deriveKey(passphrase, salt, KDF_ITERATIONS);
  const verifier = await sealBytes(crypto, key, VERIFIER_PLAINTEXT);
  const meta: VaultMeta = {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt },
    verifier,
    createdAt: now.toISOString(),
    generation: crypto.randomBytes(GENERATION_BYTES),
  };
  return { meta, key };
}

/**
 * Derives the key for an existing vault and checks it against the verifier.
 * AES-GCM fails authentication under a wrong key, so a decrypt error means
 * the passphrase is wrong.
 */
export async function deriveVaultKey(
  crypto: CryptoPort,
  meta: VaultMeta,
  passphrase: string,
): Promise<VaultKey> {
  const key = await crypto.deriveKey(passphrase, meta.kdf.salt, meta.kdf.iterations);
  const opened = await openVerifier(crypto, key, meta).catch(() => null);
  if (!opened || !bytesEqual(opened, VERIFIER_PLAINTEXT)) {
    throw new WrongPassphraseError("That passphrase does not open this vault.");
  }
  return key;
}

/** Checks a key that was derived earlier against the verifier. Throws WrongPassphraseError if it does not open this vault. */
export async function verifyVaultKey(crypto: CryptoPort, meta: VaultMeta, key: VaultKey): Promise<void> {
  const opened = await openVerifier(crypto, key, meta).catch(() => null);
  if (!opened || !bytesEqual(opened, VERIFIER_PLAINTEXT)) {
    throw new WrongPassphraseError("That session key does not open this vault.");
  }
}

export async function sealBytes(
  crypto: CryptoPort,
  key: VaultKey,
  plaintext: Bytes,
): Promise<SealedBytes> {
  // A fresh IV per seal. Reusing an IV under the same key breaks AES-GCM.
  const iv = crypto.randomBytes(IV_BYTES);
  return { iv, ciphertext: await crypto.encrypt(key, iv, plaintext) };
}

export function openBytes(
  crypto: CryptoPort,
  key: VaultKey,
  sealed: SealedBytes,
): Promise<Bytes> {
  return crypto.decrypt(key, sealed.iv, sealed.ciphertext);
}

function openVerifier(crypto: CryptoPort, key: VaultKey, meta: VaultMeta): Promise<Bytes> {
  return openBytes(crypto, key, meta.verifier);
}

function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
