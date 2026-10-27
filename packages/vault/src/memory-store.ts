import type { EncryptedRecord, RecordKind, VaultMeta, VaultStore } from "@veil/core";

/** In-memory VaultStore for tests. Not exported from the package. */
export class MemoryStore implements VaultStore {
  meta: VaultMeta | null = null;
  records = new Map<string, EncryptedRecord>();

  async getMeta() {
    return this.meta;
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
  async clear() {
    this.meta = null;
    this.records.clear();
  }
}
