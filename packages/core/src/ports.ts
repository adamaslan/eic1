import type { Bytes, EncryptedRecord, RecordKind, VaultMeta } from "./model";

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
  /** Atomically initializes an empty store with a vault header and its records. */
  initialize(meta: VaultMeta, records: EncryptedRecord[]): Promise<void>;
  /** Writes only if the current vault still has the expected random salt. */
  putRecordForVault(expectedSalt: Bytes, record: EncryptedRecord): Promise<void>;
  /** Removes the vault only if its current random salt matches the session. */
  clearForVault(expectedSalt: Bytes): Promise<void>;
  putMeta(meta: VaultMeta): Promise<void>;
  putRecord(record: EncryptedRecord): Promise<void>;
  getRecord(id: string): Promise<EncryptedRecord | null>;
  listRecords(kind: RecordKind): Promise<EncryptedRecord[]>;
  /** Every record of every kind, for backups. */
  listAllRecords(): Promise<EncryptedRecord[]>;
}
