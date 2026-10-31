import { openDB, type DBSchema, type IDBPDatabase } from "idb";
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

  async getBackupSnapshot(): Promise<{ meta: VaultMeta | null; records: EncryptedRecord[] }> {
    const tx = (await this.db()).transaction(["meta", "records"], "readonly");
    const [meta, records] = await Promise.all([
      tx.objectStore("meta").get(META_KEY),
      tx.objectStore("records").getAll(),
      tx.done,
    ]);
    return { meta: meta ?? null, records };
  }

  async initialize(meta: VaultMeta, records: EncryptedRecord[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["meta", "records"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const recordStore = tx.objectStore("records");

    try {
      const [existingMeta, existingRecordCount] = await Promise.all([
        metaStore.get(META_KEY),
        recordStore.count(),
      ]);
      if (existingMeta !== undefined || existingRecordCount > 0) {
        throw new VaultAlreadyExistsError("A vault already exists on this device.");
      }

      await Promise.all([
        metaStore.put(meta, META_KEY),
        ...records.map((record) => recordStore.put(record)),
      ]);
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because an IndexedDB request failed.
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async putRecordsForVault(expectedGeneration: Bytes, records: EncryptedRecord[], options?: { requireSameKind?: boolean }): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["meta", "records"], "readwrite");
    const metaStore = tx.objectStore("meta");
    try {
      const currentMeta = await metaStore.get(META_KEY);
      if (!currentMeta || !sameBytes(vaultGeneration(currentMeta), expectedGeneration)) {
        throw new VaultLockedError("This vault session is no longer valid. Unlock the current vault to continue.");
      }
      const recordStore = tx.objectStore("records");
      for (const record of records) {
        if (options?.requireSameKind) {
          const existing = await recordStore.get(record.id);
          if (existing && existing.kind !== record.kind) {
            throw new VaultCorruptError("A record of a different kind already uses that id.");
          }
        }
        await recordStore.put(record);
      }
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because an IndexedDB request failed.
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async deleteRecordsForVault(expectedGeneration: Bytes, ids: string[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["meta", "records"], "readwrite");
    const metaStore = tx.objectStore("meta");
    try {
      const currentMeta = await metaStore.get(META_KEY);
      if (!currentMeta || !sameBytes(vaultGeneration(currentMeta), expectedGeneration)) {
        throw new VaultLockedError("This vault session is no longer valid. Unlock the current vault to continue.");
      }
      const recordStore = tx.objectStore("records");
      for (const id of ids) {
        await recordStore.delete(id);
      }
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because an IndexedDB request failed.
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async clearForVault(expectedGeneration: Bytes): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["meta", "records"], "readwrite");
    const metaStore = tx.objectStore("meta");
    try {
      const currentMeta = await metaStore.get(META_KEY);
      if (!currentMeta || !sameBytes(vaultGeneration(currentMeta), expectedGeneration)) {
        throw new VaultLockedError("This vault session is no longer valid. Unlock the current vault to continue.");
      }
      await Promise.all([metaStore.delete(META_KEY), tx.objectStore("records").clear(), tx.done]);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because an IndexedDB request failed.
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
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

}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
