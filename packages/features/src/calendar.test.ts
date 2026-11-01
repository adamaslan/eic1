import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { VaultCorruptError } from "@veil/core";
import { createVault, exportBackup, importBackup, unlockVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { AppError, dateFromKey, localDateKey, monthGrid, weekOf } from "@veil/core";
import { addCalendarEvent, addChore, deleteCalendarEvent, deleteChore, listCalendarEvents, listChores, toggleChoreDone } from "./calendar";

let counter = 0;
const deps = () => ({ newId: () => `test-${++counter}`, now: new Date("2026-11-01T12:00:00") });

const freshVault = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "test passphrase");

describe("calendar events", () => {
  it("adds and lists events sorted by day, untimed first", async () => {
    const vault = await freshVault();
    await addCalendarEvent(vault, { title: "later", date: "2026-11-03" }, deps());
    await addCalendarEvent(vault, { title: "timed", date: "2026-11-01", time: "14:30" }, deps());
    await addCalendarEvent(vault, { title: "untimed", date: "2026-11-01" }, deps());
    const events = await listCalendarEvents(vault);
    expect(events.map((event) => event.title)).toEqual(["untimed", "timed", "later"]);
    expect(events[1]!.time).toBe("14:30");
  });

  it("rejects an empty title and an impossible date", async () => {
    const vault = await freshVault();
    await expect(addCalendarEvent(vault, { title: "   ", date: "2026-11-01" }, deps())).rejects.toBeInstanceOf(AppError);
    await expect(addCalendarEvent(vault, { title: "x", date: "11/01/2026" }, deps())).rejects.toBeInstanceOf(AppError);
    expect(await listCalendarEvents(vault)).toEqual([]);
  });

  it("keeps the note and trims it", async () => {
    const vault = await freshVault();
    const event = await addCalendarEvent(vault, { title: "dentist", date: "2026-11-05", note: "  bring card  " }, deps());
    expect(event.note).toBe("bring card");
  });

  it("deletes by id and refuses an id that is not a calendar event", async () => {
    const vault = await freshVault();
    const event = await addCalendarEvent(vault, { title: "gym", date: "2026-11-02" }, deps());
    const chore = await addChore(vault, { name: "trash", days: [1] }, deps());
    await expect(deleteCalendarEvent(vault, chore.id)).rejects.toBeInstanceOf(AppError);
    expect(await listChores(vault)).toHaveLength(1);
    await deleteCalendarEvent(vault, event.id);
    expect(await listCalendarEvents(vault)).toEqual([]);
  });

  it("skips a record that no longer parses instead of failing the list", async () => {
    const vault = await freshVault();
    await addCalendarEvent(vault, { title: "ok", date: "2026-11-01" }, deps());
    await vault.putJson("calendar", "calendar:broken", { nope: true });
    const events = await listCalendarEvents(vault);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("ok");
  });
});

describe("chores", () => {
  it("adds chores oldest-first with deduped sorted days", async () => {
    const vault = await freshVault();
    await addChore(vault, { name: "first", days: [2, 2, 1] }, deps());
    await addChore(vault, { name: "second", days: [0, 6] }, deps());
    const chores = await listChores(vault);
    expect(chores.map((chore) => chore.name)).toEqual(["first", "second"]);
    expect(chores[0]!.days).toEqual([1, 2]);
  });

  it("requires a name and at least one day", async () => {
    const vault = await freshVault();
    await expect(addChore(vault, { name: "", days: [1] }, deps())).rejects.toBeInstanceOf(AppError);
    await expect(addChore(vault, { name: "x", days: [] }, deps())).rejects.toBeInstanceOf(AppError);
    await expect(addChore(vault, { name: "x", days: [9] }, deps())).rejects.toBeInstanceOf(AppError);
  });

  it("toggles a day check-off both ways and keeps other days", async () => {
    const vault = await freshVault();
    const chore = await addChore(vault, { name: "water plants", days: [0, 3] }, deps());
    await toggleChoreDone(vault, chore.id, "2026-11-01");
    await toggleChoreDone(vault, chore.id, "2026-11-04");
    let chores = await listChores(vault);
    expect(chores[0]!.done).toEqual(["2026-11-01", "2026-11-04"]);
    await toggleChoreDone(vault, chore.id, "2026-11-01");
    chores = await listChores(vault);
    expect(chores[0]!.done).toEqual(["2026-11-04"]);
  });

  it("deletes only chores", async () => {
    const vault = await freshVault();
    const chore = await addChore(vault, { name: "dishes", days: [1, 2, 3, 4, 5] }, deps());
    const event = await addCalendarEvent(vault, { title: "show", date: "2026-11-07" }, deps());
    await expect(deleteChore(vault, event.id)).rejects.toBeInstanceOf(AppError);
    await deleteChore(vault, chore.id);
    expect(await listChores(vault)).toEqual([]);
    expect(await listCalendarEvents(vault)).toHaveLength(1);
  });
});

describe("date helpers", () => {
  it("localDateKey round-trips through dateFromKey", () => {
    const now = new Date();
    expect(localDateKey(dateFromKey(localDateKey(now)))).toBe(localDateKey(now));
  });

  it("weekOf starts on Sunday and covers 7 days", () => {
    const week = weekOf(dateFromKey("2026-11-04")); // a Wednesday
    expect(week).toHaveLength(7);
    expect(localDateKey(week[0]!)).toBe("2026-11-01");
    expect(localDateKey(week[6]!)).toBe("2026-11-07");
  });

  it("monthGrid covers the whole month with 6 stable rows", () => {
    const grid = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(grid).toHaveLength(6);
    expect(grid[0]).toHaveLength(7);
    const inMonth = grid.flat().filter((cell) => cell.inMonth);
    expect(inMonth).toHaveLength(30);
    expect(inMonth[0]!.key).toBe("2026-11-01");
    expect(inMonth.at(-1)!.key).toBe("2026-11-30");
    expect(grid[0]![0]!.weekday).toBe(0);
  });

  it("monthGrid pads a mid-week month start with the previous month", () => {
    const grid = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(grid[0]![0]!.inMonth).toBe(false);
    expect(grid[0]![0]!.key).toBe("2026-09-27");
    expect(grid.flat().filter((cell) => cell.inMonth)).toHaveLength(31);
  });
});

describe("backup compatibility", () => {
  it("calendar events and chore check-offs round-trip through export/restore with no plaintext in the file", async () => {
    const crypto = new SubtleCryptoPort();
    const store = new MemoryStore();
    const vault = await createVault({ store, crypto, now: () => new Date() }, "test passphrase");
    await addCalendarEvent(vault, { title: "plaintextprobe", date: "2026-11-03" }, deps());
    const chore = await addChore(vault, { name: "choreprobe", days: [1] }, deps());
    await toggleChoreDone(vault, chore.id, "2026-11-02");

    const backup = await exportBackup(store, new Date());
    expect(backup).not.toContain("plaintextprobe");
    expect(backup).not.toContain("choreprobe");

    const restoredStore = new MemoryStore();
    await importBackup({ store: restoredStore, crypto }, backup);
    const restored = await unlockVault({ store: restoredStore, crypto, now: () => new Date() }, "test passphrase");
    expect((await listCalendarEvents(restored)).map((event) => event.title)).toEqual(["plaintextprobe"]);
    const chores = await listChores(restored);
    expect(chores).toHaveLength(1);
    expect(chores[0]!.done).toEqual(["2026-11-02"]);
  });

  it("a backup written before these kinds existed still restores and simply reads empty", async () => {
    const crypto = new SubtleCryptoPort();
    const store = new MemoryStore();
    const vault = await createVault({ store, crypto, now: () => new Date() }, "test passphrase");
    // Only a pre-existing kind goes into this backup.
    await vault.putJson("note", "note:legacy", { id: "note:legacy", text: "keep me", createdAt: new Date().toISOString(), schemaVersion: 1 });
    const backup = await exportBackup(store, new Date());

    const restoredStore = new MemoryStore();
    await importBackup({ store: restoredStore, crypto }, backup);
    const restored = await unlockVault({ store: restoredStore, crypto, now: () => new Date() }, "test passphrase");
    expect(await listCalendarEvents(restored)).toEqual([]);
    expect(await listChores(restored)).toEqual([]);
    expect(await restored.getJson("note:legacy")).toMatchObject({ text: "keep me" });
  });

  it("restore fails loudly on a kind it does not know, so an older build never silently drops calendar data", async () => {
    const crypto = new SubtleCryptoPort();
    const store = new MemoryStore();
    const vault = await createVault({ store, crypto, now: () => new Date() }, "test passphrase");
    await addCalendarEvent(vault, { title: "important", date: "2026-11-03" }, deps());
    const backup = JSON.parse(await exportBackup(store, new Date())) as { records: { kind: string }[] };
    expect(backup.records.some((record) => record.kind === "calendar")).toBe(true);
    // Simulate what an older app (whose enum lacks these kinds) does with the file.
    for (const record of backup.records) record.kind = "kind-from-a-newer-app";
    await expect(importBackup({ store: new MemoryStore(), crypto }, JSON.stringify(backup))).rejects.toBeInstanceOf(VaultCorruptError);
  });
});

describe("DST boundaries", () => {
  it("weekOf produces 7 unique consecutive local days across DST transitions", () => {
    // 2026-11-01 is the US fall-back Sunday; 2026-03-08 was spring-forward.
    for (const key of ["2026-11-01", "2026-03-08"]) {
      const keys = weekOf(dateFromKey(key)).map(localDateKey);
      expect(new Set(keys).size).toBe(7);
      for (let index = 1; index < 7; index++) {
        const gap = dateFromKey(keys[index]!).getTime() - dateFromKey(keys[index - 1]!).getTime();
        expect(gap).toBe(24 * 3600 * 1000);
      }
    }
  });

  it("monthGrid keys stay unique and ordered across the November 2026 fall-back month", () => {
    const keys = monthGrid(2026, 10).flat().map((cell) => cell.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("day identity flips at local midnight, not UTC", () => {
    expect(localDateKey(new Date(2026, 10, 1, 23, 59))).toBe("2026-11-01");
    expect(localDateKey(new Date(2026, 10, 2, 0, 1))).toBe("2026-11-02");
  });
});
