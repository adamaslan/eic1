import { beforeEach, describe, expect, it } from "vitest";
import {
  VaultAlreadyExistsError,
  VaultLockedError,
  VaultNotFoundError,
  WrongPassphraseError,
  type EncryptedRecord,
  type Item,
  type RecordKind,
  type VaultMeta,
  type VaultStore,
} from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, newRecordId, unlockVault, type VaultDeps } from "./vault";

class MemoryStore implements VaultStore {
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
}

const NOW = new Date("2026-10-21T00:00:00Z");
const PASSPHRASE = "correct horse battery";
const note = (text: string) => new TextEncoder().encode(text);

let store: MemoryStore;
let deps: VaultDeps;

beforeEach(() => {
  store = new MemoryStore();
  deps = { store, crypto: new SubtleCryptoPort(), now: () => NOW };
});

describe("vault repository", () => {
  it("creates a vault and reads back a record in the same session", async () => {
    const vault = await createVault(deps, PASSPHRASE);

    const id = await vault.putRecord("item", note("first photo"));

    expect(await vault.getRecord(id)).toEqual(note("first photo"));
  });

  it("unlocks an existing vault and reads records written earlier", async () => {
    const first = await createVault(deps, PASSPHRASE);
    const id = await first.putRecord("item", note("kept across reloads"));
    first.lock();

    const second = await unlockVault(deps, PASSPHRASE);

    expect(await second.getRecord(id)).toEqual(note("kept across reloads"));
  });

  it("refuses a wrong passphrase", async () => {
    await createVault(deps, PASSPHRASE);

    await expect(unlockVault(deps, "not it")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("refuses to create a second vault on the same device", async () => {
    await createVault(deps, PASSPHRASE);

    await expect(createVault(deps, PASSPHRASE)).rejects.toBeInstanceOf(VaultAlreadyExistsError);
  });

  it("reports a missing vault on unlock", async () => {
    await expect(unlockVault(deps, PASSPHRASE)).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  it("never stores plaintext in the record", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const id = await vault.putRecord("item", note("secret listing text"));

    const stored = store.records.get(id);

    expect(stored?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored!.ciphertext).includes(Buffer.from("secret listing text"))).toBe(false);
  });

  it("blocks every operation after lock", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const id = await vault.putRecord("item", note("x"));
    vault.lock();

    await expect(vault.getRecord(id)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(vault.putRecord("item", note("y"))).rejects.toBeInstanceOf(VaultLockedError);
  });
});

const sampleItem = (overrides: Partial<Item> = {}): Item => ({
  id: "item-1",
  type: "listing",
  title: "ThinkPad 701C",
  category: "electronics",
  priceCents: 34000,
  description: "Works. Keys all present.",
  createdAt: "2026-10-21T10:00:00.000Z",
  likes: 3,
  mediaIds: [],
  thumbId: null,
  mediaMime: "image/webp",
  schemaVersion: 1,
  ...overrides,
});

describe("vault items", () => {
  it("stores an item and reads it back after unlock", async () => {
    const first = await createVault(deps, PASSPHRASE);
    await first.putItem(sampleItem());
    first.lock();

    const second = await unlockVault(deps, PASSPHRASE);

    expect(await second.getItem("item-1")).toEqual(sampleItem());
  });

  it("lists every item, decrypted", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    await vault.putItem(sampleItem({ id: "a" }));
    await vault.putItem(sampleItem({ id: "b", type: "photo", category: "moments", priceCents: null }));

    const items = await vault.listItems();

    expect(items.map((item) => item.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores non-item records when listing items", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    await vault.putRecord("media", note("raw bytes"));
    await vault.putItem(sampleItem());

    expect(await vault.listItems()).toHaveLength(1);
  });

  it("returns null for an unknown item id", async () => {
    const vault = await createVault(deps, PASSPHRASE);

    expect(await vault.getItem("missing")).toBeNull();
  });
});

describe("newRecordId", () => {
  it("returns 26 lowercase base32 characters and does not repeat", () => {
    const crypto = new SubtleCryptoPort();
    const ids = new Set(Array.from({ length: 200 }, () => newRecordId(crypto)));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z2-7]{26}$/);
    }
  });
});
