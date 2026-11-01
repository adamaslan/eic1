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

describe("journal date filters", () => {
  it("keeps entries inside the rolling window and drops older ones, boundary inclusive", async () => {
    const { filterJournalByDate } = await import("./journal");
    const vault = await open();
    const now = new Date("2026-10-30T12:00:00Z");
    const recent = await addJournalEntry(vault, "recent", { newId, now: new Date("2026-10-29T13:00:00Z") });
    const boundary = await addJournalEntry(vault, "boundary", { newId, now: new Date("2026-10-29T12:00:00Z") });
    const old = await addJournalEntry(vault, "old", { newId, now: new Date("2026-10-29T11:59:59Z") });
    const entries = await listJournal(vault);
    expect(filterJournalByDate(entries, "all", now)).toHaveLength(3);
    expect(filterJournalByDate(entries, "day", now).map((e) => e.text)).toEqual(["recent", "boundary"]);
    expect(filterJournalByDate(entries, "week", now)).toHaveLength(3);
    expect(filterJournalByDate(entries, "month", now)).toHaveLength(3);
    expect([recent, boundary, old]).toHaveLength(3);
  });

  it("applies text first, then date, and reports the unfiltered total", async () => {
    const { applyJournalFilters, isJournalFilterActive, emptyJournalFilter } = await import("./journal");
    const vault = await open();
    const now = new Date("2026-10-30T12:00:00Z");
    await addJournalEntry(vault, "bridge at dawn", { newId, now: new Date("2026-10-30T09:00:00Z") });
    await addJournalEntry(vault, "bridge last month", { newId, now: new Date("2026-09-15T09:00:00Z") });
    await addJournalEntry(vault, "gym today", { newId, now: new Date("2026-10-30T10:00:00Z") });
    const entries = await listJournal(vault);

    const combined = applyJournalFilters(entries, { query: "bridge", range: "week" }, now);
    expect(combined.entries.map((e) => e.text)).toEqual(["bridge at dawn"]);
    expect(combined.total).toBe(3);

    expect(applyJournalFilters(entries, { query: "", range: "day" }, now).entries).toHaveLength(2);
    expect(applyJournalFilters(entries, emptyJournalFilter, now).entries).toHaveLength(3);
    expect(isJournalFilterActive(emptyJournalFilter)).toBe(false);
    expect(isJournalFilterActive({ query: "x", range: "all" })).toBe(true);
    expect(isJournalFilterActive({ query: "", range: "month" })).toBe(true);
  });
});
