import { describe, expect, it } from "vitest";
import { AppError } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { addJournalEntry, listJournal } from "./journal";

const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "pass phrase 1");
let n = 0;
const newId = () => `j${n++}`;

describe("journal", () => {
  it("saves entries encrypted and lists them newest first", async () => {
    const vault = await open();
    await addJournalEntry(vault, "  first  ", { newId, now: new Date("2026-10-30T09:00:00Z") });
    await addJournalEntry(vault, "second", { newId, now: new Date("2026-10-30T10:00:00Z") });
    expect((await listJournal(vault)).map((entry) => entry.text)).toEqual(["second", "first"]);
  });

  it("rejects blank and oversize entries", async () => {
    const vault = await open();
    await expect(addJournalEntry(vault, "   ", { newId, now: new Date() })).rejects.toBeInstanceOf(AppError);
    await expect(addJournalEntry(vault, "x".repeat(5001), { newId, now: new Date() })).rejects.toBeInstanceOf(AppError);
  });

  it("skips a journal record that cannot be decrypted, while plain listJson still fails loudly", async () => {
    const store = new MemoryStore();
    const vault = await createVault({ store, crypto: new SubtleCryptoPort(), now: () => new Date() }, "pass phrase 1");
    await addJournalEntry(vault, "healthy", { newId, now: new Date("2026-10-30T09:00:00Z") });
    await addJournalEntry(vault, "doomed", { newId, now: new Date("2026-10-30T10:00:00Z") });
    const records = await store.listRecords("journal");
    // Corrupt the second entry's ciphertext in place (MemoryStore keeps insertion order).
    await store.putRecord({ ...records[1]!, ciphertext: new Uint8Array([1, 2, 3]) });

    expect((await listJournal(vault)).map((entry) => entry.text)).toEqual(["healthy"]);
    await expect(vault.listJson("journal")).rejects.toThrow();
  });

  it("keeps journal entries out of the notes list", async () => {
    const vault = await open();
    await addJournalEntry(vault, "private thought", { newId, now: new Date() });
    expect(await vault.listJson("note")).toEqual([]);
  });
});

describe("journal editing", () => {
  it("edits an entry keeping its id and timestamp, and validates the new text", async () => {
    const { updateJournalEntry } = await import("./journal");
    const vault = await open();
    const entry = await addJournalEntry(vault, "before", { newId, now: new Date("2026-10-30T09:00:00Z") });
    const updated = await updateJournalEntry(vault, entry.id, "  after  ");
    expect(updated).toEqual({ ...entry, text: "after" });
    expect((await listJournal(vault))[0]?.text).toBe("after");
    await expect(updateJournalEntry(vault, entry.id, "   ")).rejects.toBeInstanceOf(AppError);
    await expect(updateJournalEntry(vault, "journal:missing", "x")).rejects.toBeInstanceOf(AppError);
  });

  it("deletes one entry and ignores a missing id", async () => {
    const { deleteJournalEntry } = await import("./journal");
    const vault = await open();
    const keep = await addJournalEntry(vault, "keep", { newId, now: new Date("2026-10-30T09:00:00Z") });
    const drop = await addJournalEntry(vault, "drop", { newId, now: new Date("2026-10-30T10:00:00Z") });
    await deleteJournalEntry(vault, drop.id);
    await deleteJournalEntry(vault, "journal:never-existed");
    expect((await listJournal(vault)).map((entry) => entry.id)).toEqual([keep.id]);
  });

  it("filters case-insensitively and returns everything on a blank query", async () => {
    const { filterJournal } = await import("./journal");
    const vault = await open();
    await addJournalEntry(vault, "Brooklyn bridge at dawn", { newId, now: new Date("2026-10-30T09:00:00Z") });
    await addJournalEntry(vault, "Gym day", { newId, now: new Date("2026-10-30T10:00:00Z") });
    const entries = await listJournal(vault);
    expect(filterJournal(entries, "BRIDGE")).toHaveLength(1);
    expect(filterJournal(entries, "  ")).toHaveLength(2);
    expect(filterJournal(entries, "zzz")).toHaveLength(0);
  });
});
