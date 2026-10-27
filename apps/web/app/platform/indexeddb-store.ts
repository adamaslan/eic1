import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { EncryptedRecord, RecordKind, VaultMeta, VaultStore } from "@veil/core";

const DB_NAME = "veil";
const DB_VERSION = 2;
const META_KEY = "vault";

interface VeilDB extends DBSchema {
  meta: { key: string; value: VaultMeta };
  records: { key: string; value: EncryptedRecord; indexes: { kind: RecordKind } };
}

// Stores Uint8Array values directly (structured clone), so vault bytes are
// never base64-encoded inside the database.
export class IndexedDbVaultStore implements VaultStore {
  private dbPromise: Promise<IDBPDatabase<VeilDB>> | null = null;

  private db(): Promise<IDBPDatabase<VeilDB>> {
    this.dbPromise ??= openDB<VeilDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          database.createObjectStore("meta");
          database.createObjectStore("records", { keyPath: "id" });
        }
        if (oldVersion < 2) {
          transaction.objectStore("records").createIndex("kind", "kind");
        }
      },
    });
    return this.dbPromise;
  }

  async getMeta(): Promise<VaultMeta | null> {
    return (await (await this.db()).get("meta", META_KEY)) ?? null;
  }

  async putMeta(meta: VaultMeta): Promise<void> {
    await (await this.db()).put("meta", meta, META_KEY);
  }

  async putRecord(record: EncryptedRecord): Promise<void> {
    await (await this.db()).put("records", record);
  }

  async getRecord(id: string): Promise<EncryptedRecord | null> {
    return (await (await this.db()).get("records", id)) ?? null;
  }

  async listRecords(kind: RecordKind): Promise<EncryptedRecord[]> {
    return (await this.db()).getAllFromIndex("records", "kind", kind);
  }

  async listAllRecords(): Promise<EncryptedRecord[]> {
    return (await this.db()).getAll("records");
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["meta", "records"], "readwrite");
    await Promise.all([tx.objectStore("meta").clear(), tx.objectStore("records").clear(), tx.done]);
  }
}
