import { beforeEach, describe, expect, it } from "vitest";
import { VaultAlreadyExistsError, VaultCorruptError, WrongPassphraseError, decodeBase64, encodeBase64, type Item } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { BACKUP_FORMAT, exportBackup, importBackup } from "./backup";
import { MemoryStore } from "./memory-store";
import { createVault, unlockVault, type VaultDeps } from "./vault";

const NOW = new Date("2026-10-26T00:00:00Z");
const PASSPHRASE = "correct horse battery";

const item: Item = {
  id: "item-one",
  type: "listing",
  title: "Peugeot road bike",
  category: "bikes",
  priceCents: 12000,
  description: "Needs tires.",
  createdAt: "2026-10-25T12:00:00.000Z",
  likes: 1,
  mediaIds: [],
  thumbId: null,
  mediaMime: "image/webp",
  schemaVersion: 1,
};

function depsFor(store: MemoryStore): VaultDeps {
  return { store, crypto: new SubtleCryptoPort(), now: () => NOW };
}

let source: MemoryStore;

type BackupFixture = {
  meta: { kdf: { salt: string; iterations: number }; verifier: { iv: string; ciphertext: string } };
  records: Array<{ id: string; iv: string; ciphertext: string }>;
};

const INVALID_BACKUP_MUTATIONS: Array<[string, (backup: BackupFixture) => void]> = [
  ["empty salt", (backup) => {
    backup.meta.kdf.salt = "";
  }],
  ["short IV", (backup) => {
    backup.meta.verifier.iv = "AA==";
  }],
  ["short verifier", (backup) => {
    backup.meta.verifier.ciphertext = "AA==";
  }],
  ["excessive KDF work", (backup) => {
    backup.meta.kdf.iterations = 2_000_000;
  }],
  ["short record IV", (backup) => {
    backup.records[0]!.iv = "AA==";
  }],
  ["short record ciphertext", (backup) => {
    backup.records[0]!.ciphertext = "AA==";
  }],
  ["duplicate record identifier", (backup) => {
    backup.records[1]!.id = backup.records[0]!.id;
  }],
];

beforeEach(async () => {
  source = new MemoryStore();
  const vault = await createVault(depsFor(source), PASSPHRASE);
  await vault.putItem(item);
  await vault.putRecord("media", new Uint8Array([1, 2, 3, 250, 255]));
});

describe("base64", () => {
  it.each([[[]], [[1]], [[1, 2]], [[1, 2, 3]], [[0, 255, 128, 7]]])("round-trips %j", (values) => {
    const bytes = new Uint8Array(values);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it("matches the standard encoding", () => {
    expect(encodeBase64(new TextEncoder().encode("Veil"))).toBe("VmVpbA==");
  });

  it("rejects bad characters and lengths", () => {
    expect(() => decodeBase64("ab$d")).toThrow();
    expect(() => decodeBase64("abc")).toThrow();
  });
});

describe("backup", () => {
  it("restores into a fresh store that unlocks with the same passphrase", async () => {
    const text = await exportBackup(source, NOW);
    const target = new MemoryStore();

    const result = await importBackup(target, text);

    expect(result.records).toBe(2);
    const vault = await unlockVault(depsFor(target), PASSPHRASE);
    expect(await vault.listItems()).toEqual([item]);
  });

  it("keeps the restored vault locked to the original passphrase", async () => {
    const target = new MemoryStore();
    await importBackup(target, await exportBackup(source, NOW));

    await expect(unlockVault(depsFor(target), "not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("contains no plaintext", async () => {
    const text = await exportBackup(source, NOW);

    expect(text).toContain(BACKUP_FORMAT);
    expect(text).not.toContain("Peugeot");
  });

  it("refuses to overwrite an existing vault", async () => {
    const text = await exportBackup(source, NOW);

    await expect(importBackup(source, text)).rejects.toBeInstanceOf(VaultAlreadyExistsError);
  });

  it("keeps one complete vault when creation races with backup restore", async () => {
    const text = await exportBackup(source, NOW);
    const target = new MemoryStore();
    const createPassphrase = "new vault passphrase";
    const results = await Promise.allSettled([
      createVault(depsFor(target), createPassphrase),
      importBackup(target, text),
    ]);

    const createWon = results[0]?.status === "fulfilled";
    const restoreWon = results[1]?.status === "fulfilled";
    expect(Number(createWon) + Number(restoreWon)).toBe(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(VaultAlreadyExistsError);

    if (restoreWon) {
      const restored = await unlockVault(depsFor(target), PASSPHRASE);
      expect(await restored.listItems()).toEqual([item]);
    } else {
      const created = await unlockVault(depsFor(target), createPassphrase);
      expect(await created.listItems()).toEqual([]);
      expect(await target.listAllRecords()).toEqual([]);
    }
  });

  it.each([["not json"], ["{}"], [JSON.stringify({ format: "other", version: 1 })]])(
    "rejects %s without touching the store",
    async (text) => {
      const target = new MemoryStore();

      await expect(importBackup(target, text)).rejects.toBeInstanceOf(VaultCorruptError);
      expect(target.meta).toBeNull();
      expect(target.records.size).toBe(0);
    },
  );

  it.each(INVALID_BACKUP_MUTATIONS)("rejects %s before initializing the store", async (_case, mutate) => {
    const broken = JSON.parse(await exportBackup(source, NOW)) as BackupFixture;
    mutate(broken);
    const target = new MemoryStore();

    await expect(importBackup(target, JSON.stringify(broken))).rejects.toBeInstanceOf(VaultCorruptError);
    expect(target.meta).toBeNull();
    expect(target.records.size).toBe(0);
  });

  it("clears partial records when a field fails to decode", async () => {
    const broken = JSON.parse(await exportBackup(source, NOW));
    broken.records[1].ciphertext = "!!!!";
    const target = new MemoryStore();

    await expect(importBackup(target, JSON.stringify(broken))).rejects.toBeInstanceOf(VaultCorruptError);
    expect(target.meta).toBeNull();
    expect(target.records.size).toBe(0);
  });

  it("refuses to export when there is no vault", async () => {
    await expect(exportBackup(new MemoryStore(), NOW)).rejects.toBeInstanceOf(VaultCorruptError);
  });
});

describe("wipe", () => {
  it("removes the meta and every record", async () => {
    const vault = await unlockVault(depsFor(source), PASSPHRASE);
    await vault.wipe();

    expect(source.meta).toBeNull();
    expect(source.records.size).toBe(0);
  });
});
