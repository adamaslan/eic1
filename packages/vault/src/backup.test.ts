import { beforeEach, describe, expect, it } from "vitest";
import { VaultAlreadyExistsError, VaultCorruptError, WrongPassphraseError, decodeBase64, encodeBase64, type Item } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { BACKUP_FORMAT, exportBackup, importBackup, wipeVault } from "./backup";
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

  it.each([["not json"], ["{}"], [JSON.stringify({ format: "other", version: 1 })]])(
    "rejects %s without touching the store",
    async (text) => {
      const target = new MemoryStore();

      await expect(importBackup(target, text)).rejects.toBeInstanceOf(VaultCorruptError);
      expect(target.meta).toBeNull();
      expect(target.records.size).toBe(0);
    },
  );

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
    await wipeVault(source);

    expect(source.meta).toBeNull();
    expect(source.records.size).toBe(0);
  });
});
