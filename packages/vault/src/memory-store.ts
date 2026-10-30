import {
  VaultAlreadyExistsError,
  VaultCorruptError,
  VaultLockedError,
  type Bytes,
  type EncryptedRecord,
  type RecordKind,
  type VaultMeta,
  type VaultStore,
  vaultGeneration,
} from "@veil/core";

/** In-memory VaultStore for tests. Not exported from the package. */
export class MemoryStore implements VaultStore {
  meta: VaultMeta | null = null;
  records = new Map<string, EncryptedRecord>();

  async getMeta() {
    return this.meta;
  }
  async getBackupSnapshot() {
    return { meta: this.meta, records: [...this.records.values()] };
  }
  async initialize(meta: VaultMeta, records: EncryptedRecord[]) {
    if (this.meta !== null || this.records.size > 0) {
      throw new VaultAlreadyExistsError("A vault already exists on this device.");
    }
    this.meta = meta;
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }
  async putRecordsForVault(expectedGeneration: Bytes, records: EncryptedRecord[], options?: { requireSameKind?: boolean }) {
    if (!this.meta || !sameBytes(vaultGeneration(this.meta), expectedGeneration)) {
      throw new VaultLockedError("This vault session is no longer valid. Unlock the current vault to continue.");
    }
    // Validate the entire batch before mutating; no awaits may separate this check and write.
    if (options?.requireSameKind) {
      const kinds = new Map<string, RecordKind>();
      for (const record of records) {
        const kind = kinds.get(record.id) ?? this.records.get(record.id)?.kind;
        if (kind !== undefined && kind !== record.kind) {
          throw new VaultCorruptError("A record of a different kind already uses that id.");
        }
        kinds.set(record.id, record.kind);
      }
    }
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }
  async clearForVault(expectedGeneration: Bytes) {
    if (!this.meta || !sameBytes(vaultGeneration(this.meta), expectedGeneration)) {
      throw new VaultLockedError("This vault session is no longer valid. Unlock the current vault to continue.");
    }
    this.meta = null;
    this.records.clear();
  }
  async putMeta(meta: VaultMeta) {
    this.meta = meta;
  }
  async putRecord(record: EncryptedRecord) {
    this.records.set(record.id, record);
  }
  async getRecord(id: string) {
    return this.records.get(id) ?? null;
  }
  async listRecords(kind: RecordKind) {
    return [...this.records.values()].filter((record) => record.kind === kind);
  }
  async listAllRecords() {
    return [...this.records.values()];
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
