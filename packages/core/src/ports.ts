import type { Bytes, EncryptedRecord, VaultMeta } from "./model";

/**
 * Opaque derived key. Each platform decides what it wraps; shared code
 * passes it around but never inspects it.
 */
export interface VaultKey {
  readonly __brand: "VaultKey";
}

export interface CryptoPort {
  randomBytes(length: number): Bytes;
  deriveKey(passphrase: string, salt: Bytes, iterations: number): Promise<VaultKey>;
  encrypt(key: VaultKey, iv: Bytes, plaintext: Bytes): Promise<Bytes>;
  decrypt(key: VaultKey, iv: Bytes, ciphertext: Bytes): Promise<Bytes>;
}

export interface VaultStore {
  getMeta(): Promise<VaultMeta | null>;
  putMeta(meta: VaultMeta): Promise<void>;
  putRecord(record: EncryptedRecord): Promise<void>;
  getRecord(id: string): Promise<EncryptedRecord | null>;
}
