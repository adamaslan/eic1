import type { Bytes, CryptoPort, VaultKey } from "@veil/core";

// Uses only the global Web Crypto API: available in browsers, Node 22+, and
// React Native via a polyfill. No platform-specific globals.
const AES_KEY_BITS = 256;

export class SubtleCryptoPort implements CryptoPort {
  randomBytes(length: number): Bytes {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }

  async deriveKey(passphrase: string, salt: Bytes, iterations: number): Promise<VaultKey> {
    const { subtle } = globalThis.crypto;
    const passphraseKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const aesKey = await subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      passphraseKey,
      { name: "AES-GCM", length: AES_KEY_BITS },
      // Non-extractable: the raw key bytes never leave the crypto provider.
      false,
      ["encrypt", "decrypt"],
    );
    return toVaultKey(aesKey);
  }

  async encrypt(key: VaultKey, iv: Bytes, plaintext: Bytes): Promise<Bytes> {
    const out = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      fromVaultKey(key),
      plaintext,
    );
    return new Uint8Array(out);
  }

  async decrypt(key: VaultKey, iv: Bytes, ciphertext: Bytes): Promise<Bytes> {
    const out = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      fromVaultKey(key),
      ciphertext,
    );
    return new Uint8Array(out);
  }
}

// The port hides CryptoKey behind an opaque brand. These two casts are the only
// place that knows the wrapped type.
function toVaultKey(key: CryptoKey): VaultKey {
  return key as unknown as VaultKey;
}

function fromVaultKey(key: VaultKey): CryptoKey {
  return key as unknown as CryptoKey;
}
