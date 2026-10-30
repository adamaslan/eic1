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

  it("keeps journal entries out of the notes list", async () => {
    const vault = await open();
    await addJournalEntry(vault, "private thought", { newId, now: new Date() });
    expect(await vault.listJson("note")).toEqual([]);
  });
});
