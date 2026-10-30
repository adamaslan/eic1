import { beforeEach, describe, expect, it } from "vitest";
import {
  VaultAlreadyExistsError,
  VaultCorruptError,
  VaultLockedError,
  VaultNotFoundError,
  WrongPassphraseError,
  type Bytes,
  type Item,
  type RecordKind,
  vaultGeneration,
} from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { MemoryStore } from "./memory-store";
import { createVault, newRecordId, unlockVault, type UnlockedVault, type VaultDeps } from "./vault";

const NOW = new Date("2026-10-21T00:00:00Z");
const PASSPHRASE = "correct horse battery";
const note = (text: string) => new TextEncoder().encode(text);

let store: MemoryStore;
let deps: VaultDeps;

beforeEach(() => {
  store = new MemoryStore();
  deps = { store, crypto: new SubtleCryptoPort(), now: () => NOW };
});

async function putRecord(vault: UnlockedVault, kind: RecordKind, plaintext: Bytes): Promise<string> {
  const record = await vault.sealRecord(kind, plaintext);
  await vault.putRecords([record]);
  return record.id;
}

describe("vault repository", () => {
  it("creates a vault and reads back a record in the same session", async () => {
    const vault = await createVault(deps, PASSPHRASE);

    const id = await putRecord(vault, "item", note("first photo"));

    expect(await vault.getRecord(id)).toEqual(note("first photo"));
  });

  it("unlocks an existing vault and reads records written earlier", async () => {
    const first = await createVault(deps, PASSPHRASE);
    const id = await putRecord(first, "item", note("kept across reloads"));
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

  it("allows only one of two simultaneous vault creations", async () => {
    const results = await Promise.allSettled([
      createVault(deps, "first passphrase"),
      createVault(deps, "second passphrase"),
    ]);

    const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
    const failures = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status === "rejected" && failures[0].reason).toBeInstanceOf(VaultAlreadyExistsError);

    const winnerPassphrase = winners[0] === 0 ? "first passphrase" : "second passphrase";
    await expect(unlockVault(deps, winnerPassphrase)).resolves.toBeDefined();
  });

  it("reports a missing vault on unlock", async () => {
    await expect(unlockVault(deps, PASSPHRASE)).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  it("never stores plaintext in the record", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const id = await putRecord(vault, "item", note("secret listing text"));

    const stored = store.records.get(id);

    expect(stored?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored!.ciphertext).includes(Buffer.from("secret listing text"))).toBe(false);
  });

  it("blocks every operation after lock", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const id = await putRecord(vault, "item", note("x"));
    vault.lock();

    await expect(vault.getRecord(id)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(putRecord(vault, "item", note("y"))).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("rejects writes from a stale session after the vault is wiped and recreated", async () => {
    const staleVault = await createVault(deps, PASSPHRASE);
    const wipeSession = await unlockVault(deps, PASSPHRASE);
    await wipeSession.wipe();
    const currentVault = await createVault(deps, "new vault passphrase");

    await expect(staleVault.putItem(sampleItem())).rejects.toBeInstanceOf(VaultLockedError);
    await expect(putRecord(staleVault, "media", note("stale media"))).rejects.toBeInstanceOf(VaultLockedError);
    await expect(staleVault.wipe()).rejects.toBeInstanceOf(VaultLockedError);
    expect(await currentVault.listItems()).toEqual([]);
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
  visibility: "private",
  authorId: null,
  authorHandle: null,
  likedByMe: false,
  likedBy: [],
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
    await putRecord(vault, "media", note("raw bytes"));
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
      expect(id).not.toContain(":");
    }
  });
});


describe("JSON record kind isolation", () => {
  it("allows exactly one concurrent writer when JSON kinds share an id", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const otherSession = await unlockVault(deps, PASSPHRASE);
    const results = await Promise.allSettled([
      vault.putJson("connection", "shared-id", { winner: "connection" }),
      otherSession.putJson("note", "shared-id", { winner: "note" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBeInstanceOf(VaultCorruptError);
    const winner = results[0]!.status === "fulfilled" ? "connection" : "note";
    expect(store.records.get("shared-id")!.kind).toBe(winner);
    expect(await vault.getJson("shared-id")).toEqual({ winner });
  });

  it("rejects a guarded batch completely when an id changes kind within the batch", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    const first = await vault.sealRecord("note", note("first"));
    const second = { ...await vault.sealRecord("connection", note("second")), id: first.id };
    await expect(store.putRecordsForVault(vaultGeneration(store.meta!), [first, second], { requireSameKind: true }))
      .rejects.toBeInstanceOf(VaultCorruptError);
    expect(await store.listAllRecords()).toEqual([]);
  });

  it.each(["settings", "note", "connection", "item", "media", "thumb"] as const)("refuses to replace a %s with another kind", async (kind) => {
    const vault = await createVault(deps, PASSPHRASE);
    const id = await putRecord(vault, kind, note("original"));
    const before = store.records.get(id);
    await expect(vault.putJson(kind === "connection" ? "note" : "connection", id, { changed: true })).rejects.toBeInstanceOf(VaultCorruptError);
    expect(store.records.get(id)).toBe(before);
    expect(await vault.getRecord(id)).toEqual(note("original"));
  });

  it("allows replacing JSON records of the same kind", async () => {
    const vault = await createVault(deps, PASSPHRASE);
    await vault.putJson("connection", "connection:alice", { handle: "alice" });
    await vault.putJson("connection", "connection:alice", { handle: "new-alice" });
    expect(await vault.getJson("connection:alice")).toEqual({ handle: "new-alice" });
  });
});
