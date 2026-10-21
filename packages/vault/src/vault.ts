import {
  type Bytes,
  type Item,
  ItemSchema,
  VaultAlreadyExistsError,
  VaultCorruptError,
  VaultLockedError,
  VaultMetaSchema,
  VaultNotFoundError,
  type CryptoPort,
  type RecordKind,
  type VaultKey,
  type VaultStore,
} from "@veil/core";
import {
  createVaultMeta,
  deriveVaultKey,
  openBytes,
  sealBytes,
} from "@veil/crypto";

export interface VaultDeps {
  store: VaultStore;
  crypto: CryptoPort;
  now: () => Date;
}

export interface UnlockedVault {
  putRecord(kind: RecordKind, plaintext: Bytes): Promise<string>;
  getRecord(id: string): Promise<Bytes | null>;
  putItem(item: Item): Promise<void>;
  getItem(id: string): Promise<Item | null>;
  listItems(): Promise<Item[]>;
  /** Drops the key reference. Every later call throws VaultLockedError. */
  lock(): void;
}

export async function createVault(deps: VaultDeps, passphrase: string): Promise<UnlockedVault> {
  if (await deps.store.getMeta()) {
    throw new VaultAlreadyExistsError("A vault already exists on this device.");
  }
  const { meta, key } = await createVaultMeta(deps.crypto, passphrase, deps.now());
  await deps.store.putMeta(meta);
  return openSession(deps, key);
}

export async function unlockVault(deps: VaultDeps, passphrase: string): Promise<UnlockedVault> {
  const stored = await deps.store.getMeta();
  if (!stored) {
    throw new VaultNotFoundError("No vault on this device yet.");
  }
  const parsed = VaultMetaSchema.safeParse(stored);
  if (!parsed.success) {
    throw new VaultCorruptError("The stored vault header is unreadable.");
  }
  const key = await deriveVaultKey(deps.crypto, parsed.data, passphrase);
  return openSession(deps, key);
}

function openSession(deps: VaultDeps, initialKey: VaultKey): UnlockedVault {
  const { store, crypto } = deps;
  let key: VaultKey | null = initialKey;

  const activeKey = (): VaultKey => {
    if (!key) {
      throw new VaultLockedError("The vault is locked.");
    }
    return key;
  };

  return {
    async putRecord(kind, plaintext) {
      const sealed = await sealBytes(crypto, activeKey(), plaintext);
      const id = newRecordId(crypto);
      await store.putRecord({ v: 1, id, kind, iv: sealed.iv, ciphertext: sealed.ciphertext });
      return id;
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
      const parsed = ItemSchema.parse(item);
      const sealed = await sealBytes(crypto, activeKey(), encodeJson(parsed));
      await store.putRecord({ v: 1, id: parsed.id, kind: "item", iv: sealed.iv, ciphertext: sealed.ciphertext });
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

    lock() {
      key = null;
    },
  };
}

function encodeJson(value: unknown): Bytes {
  return new TextEncoder().encode(JSON.stringify(value));
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
