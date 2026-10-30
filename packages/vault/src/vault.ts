import {
  type Bytes,
  type EncryptedRecord,
  type Item,
  ItemSchema,
  VaultCorruptError,
  VaultLockedError,
  VaultMetaSchema,
  VaultNotFoundError,
  type CryptoPort,
  type RecordKind,
  type VaultKey,
  type VaultStore,
  vaultGeneration,
} from "@veil/core";
import {
  createVaultMeta,
  deriveVaultKey,
  openBytes,
  sealBytes,
  verifyVaultKey,
} from "@veil/crypto";

export type JsonRecordKind = Extract<RecordKind, "settings" | "connection" | "note" | "journal">;

export interface VaultDeps {
  store: VaultStore;
  crypto: CryptoPort;
  now: () => Date;
}

export interface UnlockedVault {
  /** Encrypts bytes into a record without writing it. */
  sealRecord(kind: RecordKind, plaintext: Bytes): Promise<EncryptedRecord>;
  sealItem(item: Item): Promise<EncryptedRecord>;
  /** Writes all records in one transaction: either every one lands or none does. */
  putRecords(records: EncryptedRecord[]): Promise<void>;
  getRecord(id: string): Promise<Bytes | null>;
  putItem(item: Item): Promise<void>;
  getItem(id: string): Promise<Item | null>;
  listItems(): Promise<Item[]>;
  /** Seals a JSON value as a settings, connection, or note record and writes it. Replaces only records of the same kind. */
  putJson(kind: JsonRecordKind, id: string, value: unknown): Promise<void>;
  getJson(id: string): Promise<unknown | null>;
  listJson(kind: JsonRecordKind): Promise<unknown[]>;
  /** Wipes this vault only while its original header is still current. */
  wipe(): Promise<void>;
  /** Drops the key reference. Every later call throws VaultLockedError. */
  lock(): void;
}

export async function createVault(deps: VaultDeps, passphrase: string): Promise<UnlockedVault> {
  return (await createVaultKeyed(deps, passphrase)).vault;
}

export async function unlockVault(deps: VaultDeps, passphrase: string): Promise<UnlockedVault> {
  return (await unlockVaultKeyed(deps, passphrase)).vault;
}

/** Like createVault, but also returns the key so the platform can keep it for a resumable session. */
export async function createVaultKeyed(deps: VaultDeps, passphrase: string): Promise<{ vault: UnlockedVault; key: VaultKey }> {
  const { meta, key } = await createVaultMeta(deps.crypto, passphrase, deps.now());
  await deps.store.initialize(meta, []);
  return { vault: openSession(deps, key, vaultGeneration(meta)), key };
}

/**
 * Reopens the vault with a key kept from an earlier unlock. The key is checked against the
 * stored verifier, so a key from a replaced, restored, or wiped vault is rejected.
 */
export async function resumeVault(deps: VaultDeps, key: VaultKey): Promise<UnlockedVault> {
  const stored = await deps.store.getMeta();
  if (!stored) {
    throw new VaultNotFoundError("No vault on this device yet.");
  }
  const parsed = VaultMetaSchema.safeParse(stored);
  if (!parsed.success) {
    throw new VaultCorruptError("The stored vault header is unreadable.");
  }
  await verifyVaultKey(deps.crypto, parsed.data, key);
  return openSession(deps, key, vaultGeneration(parsed.data));
}

export async function unlockVaultKeyed(deps: VaultDeps, passphrase: string): Promise<{ vault: UnlockedVault; key: VaultKey }> {
  const stored = await deps.store.getMeta();
  if (!stored) {
    throw new VaultNotFoundError("No vault on this device yet.");
  }
  const parsed = VaultMetaSchema.safeParse(stored);
  if (!parsed.success) {
    throw new VaultCorruptError("The stored vault header is unreadable.");
  }
  const key = await deriveVaultKey(deps.crypto, parsed.data, passphrase);
  return { vault: openSession(deps, key, vaultGeneration(parsed.data)), key };
}

function openSession(deps: VaultDeps, initialKey: VaultKey, expectedGeneration: Bytes): UnlockedVault {
  const { store, crypto } = deps;
  let key: VaultKey | null = initialKey;

  const activeKey = (): VaultKey => {
    if (!key) {
      throw new VaultLockedError("The vault is locked.");
    }
    return key;
  };

  const sealItem = async (item: Item): Promise<EncryptedRecord> => {
    const parsed = ItemSchema.parse(item);
    const sealed = await sealBytes(crypto, activeKey(), encodeJson(parsed));
    return { v: 1, id: parsed.id, kind: "item", iv: sealed.iv, ciphertext: sealed.ciphertext };
  };

  return {
    async sealRecord(kind, plaintext) {
      const sealed = await sealBytes(crypto, activeKey(), plaintext);
      return { v: 1, id: newRecordId(crypto), kind, iv: sealed.iv, ciphertext: sealed.ciphertext };
    },

    sealItem,

    async putRecords(records) {
      await store.putRecordsForVault(expectedGeneration, records);
    },

    async getRecord(id) {
      const keyInUse = activeKey();
      const record = await store.getRecord(id);
      if (!record) {
        return null;
      }
      return openBytes(crypto, keyInUse, { iv: record.iv, ciphertext: record.ciphertext });
    },

    async putItem(item) {
      await store.putRecordsForVault(expectedGeneration, [await sealItem(item)]);
    },

    async getItem(id) {
      const keyInUse = activeKey();
      const record = await store.getRecord(id);
      if (!record || record.kind !== "item") {
        return null;
      }
      return decodeItem(await openBytes(crypto, keyInUse, { iv: record.iv, ciphertext: record.ciphertext }));
    },

    async listItems() {
      const keyInUse = activeKey();
      const records = await store.listRecords("item");
      return Promise.all(
        records.map(async (record) =>
          decodeItem(await openBytes(crypto, keyInUse, { iv: record.iv, ciphertext: record.ciphertext })),
        ),
      );
    },

    async putJson(kind, id, value) {
      const keyInUse = activeKey();
      const sealed = await sealBytes(crypto, keyInUse, encodeJson(value));
      await store.putRecordsForVault(expectedGeneration, [
        { v: 1, id, kind, iv: sealed.iv, ciphertext: sealed.ciphertext },
      ], { requireSameKind: true });
    },

    async getJson(id) {
      const keyInUse = activeKey();
      const record = await store.getRecord(id);
      if (!record || record.kind === "item" || record.kind === "media" || record.kind === "thumb") {
        return null;
      }
      return decodeJson(await openBytes(crypto, keyInUse, { iv: record.iv, ciphertext: record.ciphertext }));
    },

    async listJson(kind) {
      const keyInUse = activeKey();
      const records = await store.listRecords(kind);
      return Promise.all(
        records.map(async (record) =>
          decodeJson(await openBytes(crypto, keyInUse, { iv: record.iv, ciphertext: record.ciphertext })),
        ),
      );
    },

    lock() {
      key = null;
    },

    async wipe() {
      activeKey();
      await deps.store.clearForVault(expectedGeneration);
      key = null;
    },
  };
}

function encodeJson(value: unknown): Bytes {
  const json = JSON.stringify(value);
  if (typeof json !== "string") {
    throw new VaultCorruptError("This value could not be encoded as JSON.");
  }
  return new TextEncoder().encode(json);
}

function decodeJson(bytes: Bytes): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new VaultCorruptError("A stored record could not be read.");
  }
}

function decodeItem(bytes: Bytes): Item {
  const parsed = ItemSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) {
    throw new VaultCorruptError("A stored item could not be read.");
  }
  return parsed.data;
}

// 128 random bits as lowercase base32 (26 chars). Never sequential.
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newRecordId(crypto: CryptoPort): string {
  const bytes = crypto.randomBytes(16);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    // Mask keeps only the low bits still waiting to be emitted.
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}
