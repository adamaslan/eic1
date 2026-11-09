import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { VaultCorruptError } from "@veil/core";
import { createVault, exportBackup, importBackup, unlockVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { AppError, dateFromKey, localDateKey, monthGrid, monthLabel, weekOf } from "@veil/core";
import { addCalendarEvent, addChore, addChorePerson, assigneeForDate, assignmentsForWeek, clearChoreOverride, deleteCalendarEvent, deleteChore, getChoreChart, listChorePeople, listCalendarEvents, listChores, setChoreOverride, toggleChoreDone } from "./calendar";

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

  it("rejects dates that do not exist instead of saving an event no day cell can show", async () => {
    const vault = await freshVault();
    // JS Date normalizes 2026-02-30 to Mar 2; a regex alone would save it and the grid groups by the raw key.
    await expect(addCalendarEvent(vault, { title: "ghost", date: "2026-02-30" }, deps())).rejects.toThrow("Pick a real date.");
    await expect(addCalendarEvent(vault, { title: "ghost", date: "2026-13-01" }, deps())).rejects.toThrow("Pick a real date.");
    await expect(addCalendarEvent(vault, { title: "ghost", date: "2026-04-31" }, deps())).rejects.toThrow("Pick a real date.");
    expect(await listCalendarEvents(vault)).toEqual([]);
    // Positive edges: real days, including a leap day, still save.
    await addCalendarEvent(vault, { title: "leap", date: "2024-02-29" }, deps());
    await addCalendarEvent(vault, { title: "april", date: "2026-04-30" }, deps());
    expect((await listCalendarEvents(vault)).map((event) => event.title).sort()).toEqual(["april", "leap"]);
  });

  it("refuses a check-off for a day that does not exist and writes nothing", async () => {
    const vault = await freshVault();
    const chore = await addChore(vault, { name: "water plants", days: [0, 3] }, deps());
    // A malformed key would fail ChoreSchema on the next read, hiding the chore and making it undeletable.
    await expect(toggleChoreDone(vault, chore.id, "junk")).rejects.toThrow("That day does not exist.");
    await expect(toggleChoreDone(vault, chore.id, "2026-02-30")).rejects.toThrow("That day does not exist.");
    const chores = await listChores(vault);
    expect(chores).toHaveLength(1);
    expect(chores[0]!.done).toEqual([]);
  });

  it("accepts early-year real dates instead of shifting them into the 1900s or rejecting them", async () => {
    const vault = await freshVault();
    // localDateKey must zero-pad years, and Date must not map years 0-99 to 1900-1999.
    await addCalendarEvent(vault, { title: "ancient", date: "0050-03-01" }, deps());
    await addCalendarEvent(vault, { title: "millennium", date: "0100-01-01" }, deps());
    await addCalendarEvent(vault, { title: "year zero", date: "0000-02-29" }, deps());
    const keys = (await listCalendarEvents(vault)).map((event) => event.date);
    expect(keys).toEqual(["0000-02-29", "0050-03-01", "0100-01-01"]);
    expect(localDateKey(dateFromKey("0050-03-01"))).toBe("0050-03-01");
  });

  it("keeps an event on a day a timezone skipped, since the day is real regardless of the reader's zone", async () => {
    const vault = await freshVault();
    // Pacific/Apia skipped 2011-12-30 entirely; validation must not depend on the device's timezone.
    await addCalendarEvent(vault, { title: "skipped in some zones", date: "2011-12-30" }, deps());
    expect((await listCalendarEvents(vault)).map((event) => event.title)).toEqual(["skipped in some zones"]);
  });

  it("builds week and month grids for early years without shifting them into the 1900s", () => {
    const grid = monthGrid(50, 2);
    expect(grid.flat().find((cell) => cell.inMonth)!.key).toBe("0050-03-01");
    expect(weekOf(dateFromKey("0050-03-01")).map(localDateKey)[0]!.startsWith("0050-")).toBe(true);
    // Year 0000 must not read the same as year 0001 in the month heading.
    expect(monthLabel(0, 1)).not.toBe(monthLabel(1, 1));
  });

  it("rejects a malformed time instead of failing with a raw schema error", async () => {
    const vault = await freshVault();
    await expect(addCalendarEvent(vault, { title: "x", date: "2026-11-01", time: "25:00" }, deps())).rejects.toThrow("Pick a real time");
    await expect(addCalendarEvent(vault, { title: "x", date: "2026-11-01", time: "9am" }, deps())).rejects.toBeInstanceOf(AppError);
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

  it("skips a stored event whose date does not exist, so it can never land in a grid cell by accident", async () => {
    const vault = await freshVault();
    await addCalendarEvent(vault, { title: "ok", date: "2026-11-01" }, deps());
    await vault.putJson("calendar", "calendar:ghost", {
      id: "calendar:ghost",
      title: "ghost",
      date: "2026-02-30",
      time: null,
      note: "",
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    expect((await listCalendarEvents(vault)).map((event) => event.title)).toEqual(["ok"]);
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

  it("merges a check-off that raced another tab instead of dropping one side", async () => {
    const vault = await freshVault();
    const chore = await addChore(vault, { name: "water plants", days: [0, 3] }, deps());
    const original = vault.putJsonIfUnchanged.bind(vault);
    let injected = false;
    vault.putJsonIfUnchanged = async (kind, id, value, expected) => {
      if (!injected) {
        injected = true;
        // The other tab commits its own check-off first, so ours must not overwrite it.
        await original("chore", id, { ...chore, done: ["2026-11-04"] }, expected);
        throw new AppError("The saved profile changed. Review the latest feed profile before updating. Nothing was overwritten.");
      }
      return original(kind, id, value, expected);
    };
    const updated = await toggleChoreDone(vault, chore.id, "2026-11-01");
    expect([...updated.done].sort()).toEqual(["2026-11-01", "2026-11-04"]);
    const chores = await listChores(vault);
    expect([...chores[0]!.done].sort()).toEqual(["2026-11-01", "2026-11-04"]);
  });

  it("overwrites nothing and says so when a check-off keeps racing", async () => {
    const vault = await freshVault();
    const chore = await addChore(vault, { name: "dishes", days: [1] }, deps());
    vault.putJsonIfUnchanged = async () => {
      throw new AppError("The saved profile changed. Review the latest feed profile before updating. Nothing was overwritten.");
    };
    await expect(toggleChoreDone(vault, chore.id, "2026-11-02")).rejects.toThrow("Nothing was overwritten. Try again.");
    const chores = await listChores(vault);
    expect(chores[0]!.done).toEqual([]);
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

describe("chore rotation (names switch with dates, sequential per person, 8 weeks ahead)", () => {
  // Adam 2026-11-03: "names can be switched with dates and chores change sequentially
  // for each person for up to 8 weeks ahead". Rotation is weekly and deterministic;
  // a per-date override switches a name without touching the rest of the chart.
  // Semantics v2 (review): the FIRST people list takes effect immediately and can grow
  // during its own week (nothing earlier ever showed it). Any later change takes effect
  // NEXT week, so a current or past day's name never changes after it was shown.
  const later = (iso: string) => ({ newId: deps().newId, now: new Date(iso) });

  it("rotates each chore to the next person every week, sequentially, across the 8-week horizon", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1, 3, 5] }, deps());
    const trash = await addChore(vault, { name: "Trash", days: [2] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps()); // same week: first list still growing
    // Week of Sun 2026-11-01 (week index 0): first chore -> first person, second -> second.
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Ada");
    expect(await assigneeForDate(vault, trash.id, "2026-11-03")).toBe("Grace");
    // Week 1: both move to the next person in sequence.
    expect(await assigneeForDate(vault, dishes.id, "2026-11-09")).toBe("Grace");
    expect(await assigneeForDate(vault, trash.id, "2026-11-10")).toBe("Ada");
    // Week 2: cycles back.
    expect(await assigneeForDate(vault, dishes.id, "2026-11-16")).toBe("Ada");
    // The horizon reaches 8 weeks ahead and stays consistent there.
    expect(await assigneeForDate(vault, dishes.id, "2026-12-28")).toBe("Ada"); // week 8 = even
  });

  it("a name switched for one date changes only that date, not the week's other dates or later weeks", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1, 3, 5] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps());
    await setChoreOverride(vault, dishes.id, "2026-11-04", "Grace", deps());
    expect(await assigneeForDate(vault, dishes.id, "2026-11-04")).toBe("Grace"); // switched
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Ada"); // same week, untouched
    expect(await assigneeForDate(vault, dishes.id, "2026-11-06")).toBe("Ada");
    expect(await assigneeForDate(vault, dishes.id, "2026-11-11")).toBe("Grace"); // rotation unaffected
    // Clearing the switch returns the date to the rotation.
    await clearChoreOverride(vault, dishes.id, "2026-11-04");
    expect(await assigneeForDate(vault, dishes.id, "2026-11-04")).toBe("Ada");
  });

  it("a person joining after setup week takes effect NEXT week - current and past days never change", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps()); // setup week of 2026-11-01
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Ada");
    // Grace joins mid-next-week; she cannot appear before the week after she joined.
    await addChorePerson(vault, "Grace", later("2026-11-04T12:00:00")); // still setup week -> grows first list? no: same week, so amended
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Ada"); // week unchanged
    expect(await assigneeForDate(vault, dishes.id, "2026-11-09")).toBe("Grace");
    // Someone joining a LATER week starts the week after, leaving the current one alone.
    await addChorePerson(vault, "Hopper", later("2026-11-10T12:00:00"));
    expect(await assigneeForDate(vault, dishes.id, "2026-11-09")).toBe("Grace"); // this week untouched
    expect(await assigneeForDate(vault, dishes.id, "2026-11-16")).toBe("Ada"); // 3 people from 11-15: slot0 week0
    expect(await assigneeForDate(vault, dishes.id, "2026-11-23")).toBe("Grace"); // week1
    expect(await assigneeForDate(vault, dishes.id, "2026-11-30")).toBe("Hopper"); // week2
    // Days before the chart existed have no assignee at all - the chart never invents history.
    expect(await assigneeForDate(vault, dishes.id, "2026-10-26")).toBeNull();
  });

  it("weeks read the list of their own era: nothing before the first list, era list between joins", async () => {
    // Mutation killer: era selection must use the in-effect list, never the latest and
    // never a fallback into weeks the chart predates.
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1] }, deps());
    const laundry = await addChore(vault, { name: "Laundry", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps()); // effective week of 2026-11-01
    // Grace joins a week LATER, so the [Ada] era really existed on the chart.
    await addChorePerson(vault, "Grace", later("2026-11-08T12:00:00")); // effective 2026-11-15
    // Before the chart existed: no assignees at all.
    expect(await assigneeForDate(vault, dishes.id, "2026-10-26")).toBeNull();
    expect(await assigneeForDate(vault, laundry.id, "2026-10-26")).toBeNull();
    // The [Ada] era weeks (11-01 and 11-08): still Ada for both, Grace's join must not rewrite them.
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Ada");
    expect(await assigneeForDate(vault, laundry.id, "2026-11-02")).toBe("Ada");
    expect(await assigneeForDate(vault, laundry.id, "2026-11-09")).toBe("Ada");
    // From Grace's week on: slot 1 is Grace, and rotation advances weekly.
    expect(await assigneeForDate(vault, laundry.id, "2026-11-16")).toBe("Grace");
    expect(await assigneeForDate(vault, laundry.id, "2026-11-23")).toBe("Ada");
  });

  it("rejects a switch to a name not on the chart and an impossible date", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await expect(setChoreOverride(vault, dishes.id, "2026-11-04", "Nobody", deps())).rejects.toThrow(/not on the chart/);
    await expect(setChoreOverride(vault, dishes.id, "2026-02-30", "Ada", deps())).rejects.toThrow(/real date/);
    expect(await assigneeForDate(vault, dishes.id, "2026-11-04")).toBe("Ada"); // unchanged
  });

  it("with no people every date has no assignee, and week edges fall on the right Sundays", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [0, 6] }, deps()); // Sun + Sat
    expect(await assigneeForDate(vault, dishes.id, "2026-11-01")).toBeNull(); // Sunday, no people
    await addChorePerson(vault, "Ada", deps());
    // Sunday 11-01 and Saturday 11-07 are the same week; Sunday 11-08 is the next.
    expect(await assigneeForDate(vault, dishes.id, "2026-11-01")).toBe("Ada");
    expect(await assigneeForDate(vault, dishes.id, "2026-11-07")).toBe("Ada");
    await addChorePerson(vault, "Grace", deps()); // same setup week: list grows now
    expect(await assigneeForDate(vault, dishes.id, "2026-11-07")).toBe("Ada"); // slot0, week0
    expect(await assigneeForDate(vault, dishes.id, "2026-11-08")).toBe("Grace"); // next week
  });

  it("rotation math survives a DST boundary week (noon-anchored local dates)", async () => {
    // US DST ends 2026-11-01: weeks around it must stay 7-day aligned.
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1] }, later("2026-10-25T12:00:00"));
    await addChorePerson(vault, "Ada", later("2026-10-25T12:00:00")); // setup week of 10-25
    await addChorePerson(vault, "Grace", later("2026-10-25T12:00:00"));
    expect(await assigneeForDate(vault, dishes.id, "2026-10-26")).toBe("Ada"); // week0
    expect(await assigneeForDate(vault, dishes.id, "2026-11-02")).toBe("Grace"); // week1 across DST end
    expect(await assigneeForDate(vault, dishes.id, "2026-11-09")).toBe("Ada"); // week2
  });

  it("assignments survive a vault reload and legacy chores without slots rotate in creation order", async () => {
    const vault = await freshVault();
    const first = await addChore(vault, { name: "First added", days: [1] }, deps());
    const second = await addChore(vault, { name: "Second added", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps());
    const before = [await assigneeForDate(vault, first.id, "2026-11-09"), await assigneeForDate(vault, second.id, "2026-11-09")];
    expect(before).toEqual(["Grace", "Ada"]);
    // Simulate a reload by re-reading through the list path: same answer, same order.
    expect(await assigneeForDate(vault, first.id, "2026-11-09")).toBe("Grace");
    expect(await assigneeForDate(vault, second.id, "2026-11-09")).toBe("Ada");
  });

  it("assignmentsForWeek matches the per-date answers and respects scheduled days and switches", async () => {
    const vault = await freshVault();
    const dishes = await addChore(vault, { name: "Dishes", days: [1, 3] }, deps());
    const trash = await addChore(vault, { name: "Trash", days: [2] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps());
    await setChoreOverride(vault, dishes.id, "2026-11-04", "Grace", deps());
    const map = await assignmentsForWeek(vault, new Date("2026-11-01T12:00:00"));
    expect(Object.fromEntries(map.get(dishes.id)!)).toEqual({ "2026-11-02": "Ada", "2026-11-04": "Grace" });
    expect(Object.fromEntries(map.get(trash.id)!)).toEqual({ "2026-11-03": "Grace" });
    expect(map.get(trash.id)!.has("2026-11-02")).toBe(false); // unscheduled day: no entry
  });

  it("deleting a chore keeps the remaining slots stable and never touches check-offs or other switches", async () => {
    // Slots are persisted with tombstones: a delete leaves the rotation of every other
    // chore untouched, past and future. Overrides are keyed by chore id and survive;
    // done keys live on each chore record and are untouched.
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [1] }, deps());
    const b = await addChore(vault, { name: "B", days: [1] }, deps());
    const c = await addChore(vault, { name: "C", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps());
    await setChoreOverride(vault, c.id, "2026-11-02", "Grace", deps());
    expect(await assigneeForDate(vault, c.id, "2026-11-09")).toBe("Grace"); // slot2, week1: (2+1)%2 = 1
    expect(await assigneeForDate(vault, b.id, "2026-11-09")).toBe("Ada"); // slot1, week1
    await deleteChore(vault, a.id);
    // C stays in slot 2 and B in slot 1: both weeks unchanged. The switch for 11-02 stands.
    expect(await assigneeForDate(vault, c.id, "2026-11-09")).toBe("Grace");
    expect(await assigneeForDate(vault, b.id, "2026-11-09")).toBe("Ada");
    expect(await assigneeForDate(vault, c.id, "2026-11-02")).toBe("Grace"); // switch, not rotation
    expect((await listChores(vault)).map((chore) => chore.name)).toEqual(["B", "C"]);
  });

  it("the chart record hides from chore reads, chore deletes, and check-offs but rides backup/restore", async () => {
    const vault = await freshVault();
    await addChore(vault, { name: "Dishes", days: [1] }, deps());
    await addChorePerson(vault, "Ada", deps());
    // Old-reader safety: listChores parses Chore records only and skips the chart record.
    expect((await listChores(vault)).map((chore) => chore.name)).toEqual(["Dishes"]);
    await expect(deleteChore(vault, "chore-chart")).rejects.toThrow(/no longer exists/);
    await expect(toggleChoreDone(vault, "chore-chart", "2026-11-02")).rejects.toThrow(/no longer exists/);
    // Backup round-trip carries the chart: people, eras, and switches survive.
    const crypto = new SubtleCryptoPort();
    const store = new MemoryStore();
    const source = await createVault({ store, crypto, now: () => new Date() }, "test passphrase");
    const sourceChore = await addChore(source, { name: "Dishes", days: [1] }, deps());
    await addChorePerson(source, "Ada", deps());
    await addChorePerson(source, "Grace", deps());
    await setChoreOverride(source, sourceChore.id, "2026-11-02", "Grace", deps());
    const backup = await exportBackup(store, new Date());
    const restoredStore = new MemoryStore();
    await importBackup({ store: restoredStore, crypto }, backup);
    const restored = await unlockVault({ store: restoredStore, crypto, now: () => new Date() }, "test passphrase");
    expect(await assigneeForDate(restored, sourceChore.id, "2026-11-02")).toBe("Grace"); // switch
    expect(await assigneeForDate(restored, sourceChore.id, "2026-11-09")).toBe("Grace"); // slot0, week1: (0+1)%2 = 1
    expect(await assigneeForDate(restored, sourceChore.id, "2026-11-16")).toBe("Ada"); // week2 cycles back
    expect((await listChores(restored)).map((chore) => chore.name)).toEqual(["Dishes"]);
  });
});


describe("chore rotation era and slot integrity (watcher findings on a525820b)", () => {
  const at = (iso: string) => ({ newId: deps().newId, now: new Date(`${iso}T12:00:00`) });

  it("deletion must preserve another chore's already-shown historical assignee", async () => {
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [1] }, at("2026-11-01"));
    const b = await addChore(vault, { name: "B", days: [1] }, at("2026-11-01"));
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    await addChorePerson(vault, "Grace", at("2026-11-01"));
    const before = await assigneeForDate(vault, b.id, "2026-11-02");
    expect(before).toBe("Grace"); // slot 1, era week 0
    await deleteChore(vault, a.id);
    expect(await assigneeForDate(vault, b.id, "2026-11-02")).toBe(before);
    expect(await assigneeForDate(vault, b.id, "2026-11-09")).toBe("Ada"); // slot 1, week 1 - also unmoved
  });

  it("a later era's first-week addition must not rewrite earlier days", async () => {
    const vault = await freshVault();
    await addChore(vault, { name: "A", days: [1] }, at("2026-11-01"));
    await addChore(vault, { name: "B", days: [1] }, at("2026-11-01"));
    const c = await addChore(vault, { name: "C", days: [1] }, at("2026-11-01"));
    await addChorePerson(vault, "Ada", at("2026-11-01")); // setup era 11-01
    await addChorePerson(vault, "Grace", at("2026-11-08")); // new era 11-15
    const before = await assigneeForDate(vault, c.id, "2026-11-16");
    expect(before).toBe("Ada"); // slot 2, week 0 of the 11-15 era
    await addChorePerson(vault, "Hopper", at("2026-11-18")); // era's first week, NOT setup
    expect(await assigneeForDate(vault, c.id, "2026-11-16")).toBe(before);
    const chart = (await getChoreChart(vault))!;
    expect(chart.rotations.map((rotation) => rotation.effectiveWeek)).toEqual(["2026-11-01", "2026-11-15", "2026-11-22"]);
    expect(chart.rotations[1]!.people).toEqual(["Ada", "Grace"]); // Hopper absent from the 11-15 era
    expect(chart.rotations[2]!.people).toEqual(["Ada", "Grace", "Hopper"]);
  });

  it("two additions in one week share a single pending future era", async () => {
    const vault = await freshVault();
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    await addChorePerson(vault, "Kip", at("2026-11-08"));
    await addChorePerson(vault, "Lou", at("2026-11-09"));
    const chart = (await getChoreChart(vault))!;
    expect(chart.rotations.map((rotation) => rotation.effectiveWeek)).toEqual(["2026-11-01", "2026-11-15"]);
    expect(chart.rotations[1]!.people).toEqual(["Ada", "Kip", "Lou"]);
  });

  it("a future-date override uses the roster effective on that date", async () => {
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [1] }, at("2026-11-01"));
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    await addChorePerson(vault, "Grace", at("2026-11-08")); // effective 11-15
    await expect(setChoreOverride(vault, a.id, "2026-11-16", "Grace", at("2026-11-10"))).resolves.toBeTruthy();
    expect(await assigneeForDate(vault, a.id, "2026-11-16")).toBe("Grace");
    await expect(setChoreOverride(vault, a.id, "2026-11-10", "Grace", at("2026-11-10"))).rejects.toThrow(/not on the chart for that week/);
    await expect(setChoreOverride(vault, a.id, "2026-10-26", "Ada", at("2026-11-10"))).rejects.toThrow(/before the chore was added/);
  });

  it("dates before chart creation must not gain invented assignees", async () => {
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [1] }, at("2026-11-01"));
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    expect(await assigneeForDate(vault, a.id, "2026-10-26")).toBeNull();
    expect((await assignmentsForWeek(vault, new Date("2026-10-26T12:00:00"))).size).toBe(0);
    expect(await assigneeForDate(vault, a.id, "2026-11-02")).toBe("Ada"); // era week 0 still assigns
  });

  it("a chore that predates the chart still has no assignee before the first era (fallback killer)", async () => {
    // The chore exists before the era starts, so only the era boundary - not the
    // creation guard - can produce null here. A fallback to the earliest list fails this.
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [0, 1, 2, 3, 4, 5, 6] }, at("2026-10-25"));
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    expect(await assigneeForDate(vault, a.id, "2026-10-26")).toBeNull(); // chore exists, chart does not
    expect(await assigneeForDate(vault, a.id, "2026-11-02")).toBe("Ada");
  });

  it("a chore gains no assignments before its own creation", async () => {
    const vault = await freshVault();
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    const a = await addChore(vault, { name: "new chore", days: [0, 1, 2, 3, 4, 5, 6] }, at("2026-11-18"));
    expect(await assigneeForDate(vault, a.id, "2026-11-02")).toBeNull(); // weeks earlier
    expect(await assigneeForDate(vault, a.id, "2026-11-16")).toBeNull(); // same week, before creation day
    expect(await assigneeForDate(vault, a.id, "2026-11-18")).toBe("Ada"); // creation day onward
    await expect(setChoreOverride(vault, a.id, "2026-11-02", "Ada", at("2026-11-18"))).rejects.toThrow(/before the chore was added/);
  });
});

describe("chore chart unknown or malformed records fail closed (watcher finding 6)", () => {
  const at = (iso: string) => ({ newId: deps().newId, now: new Date(`${iso}T12:00:00`) });

  it("a newer-version chart is preserved untouched and every write refuses", async () => {
    const vault = await freshVault();
    const future = {
      id: "chore-chart",
      rotations: [{ effectiveWeek: "2026-11-01", people: ["Original"] }],
      overrides: [],
      schemaVersion: 2,
      futureData: "do not drop",
    };
    await vault.putJson("chore", "chore-chart", future);
    await expect(addChorePerson(vault, "New", at("2026-11-01"))).rejects.toThrow(/can't read/);
    await expect(setChoreOverride(vault, "any-chore", "2026-11-02", "Original", at("2026-11-01"))).rejects.toThrow(/can't read|no longer exists/);
    await expect(clearChoreOverride(vault, "any-chore", "2026-11-02")).rejects.toThrow(/can't read/);
    await expect(getChoreChart(vault)).rejects.toThrow(/can't read/);
    await expect(listChorePeople(vault)).rejects.toThrow(/can't read/);
    // The bytes are exactly as they were: nothing parsed-as-empty, nothing rewritten.
    expect(await vault.getJson("chore-chart")).toEqual(future);
  });

  it("a malformed chart record is preserved and refuses writes", async () => {
    const vault = await freshVault();
    const garbage = { id: "chore-chart", rotations: "not-an-array" };
    await vault.putJson("chore", "chore-chart", garbage);
    await expect(addChorePerson(vault, "New", at("2026-11-01"))).rejects.toThrow(/can't read/);
    expect(await vault.getJson("chore-chart")).toEqual(garbage);
  });

  it("a chart with unknown extra keys is refused rather than silently stripped on rewrite", async () => {
    const vault = await freshVault();
    const withExtra = {
      id: "chore-chart",
      rotations: [{ effectiveWeek: "2026-11-01", people: ["Ada"] }],
      overrides: [],
      schemaVersion: 1,
      futureField: { nested: [1, 2, 3] },
    };
    await vault.putJson("chore", "chore-chart", withExtra);
    await expect(addChorePerson(vault, "New", at("2026-11-01"))).rejects.toThrow(/can't read/);
    expect(await vault.getJson("chore-chart")).toEqual(withExtra);
  });
});

describe("chore slot registration on addChore and nested fail-closed (watcher v2 findings)", () => {
  const at = (iso: string) => ({ newId: deps().newId, now: new Date(`${iso}T12:00:00`) });

  it("deleting a post-setup chore preserves a later post-setup chore's assignments", async () => {
    const vault = await freshVault();
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    await addChorePerson(vault, "Grace", at("2026-11-01"));
    // Chores added AFTER the chart exists must still get persisted slots.
    const a = await addChore(vault, { name: "A", days: [1] }, at("2026-11-08"));
    const b = await addChore(vault, { name: "B", days: [1] }, at("2026-11-08"));
    const chart = (await getChoreChart(vault))!;
    expect(chart.slots).toEqual([a.id, b.id]);
    const before = await assigneeForDate(vault, b.id, "2026-11-09");
    expect(before).toBe("Ada"); // slot 1, week 1: (1+1)%2
    await deleteChore(vault, a.id);
    expect(await assigneeForDate(vault, b.id, "2026-11-09")).toBe(before);
    expect(await assigneeForDate(vault, b.id, "2026-11-16")).toBe("Grace"); // week 2 also unmoved
  });

  it("interleaving adds, a delete, and a reload never re-sequences survivors", async () => {
    const store = new MemoryStore();
    const crypto = new SubtleCryptoPort();
    const vault = await createVault({ store, crypto, now: () => new Date() }, "test passphrase");
    await addChorePerson(vault, "Ada", at("2026-11-01"));
    await addChorePerson(vault, "Grace", at("2026-11-01"));
    const a = await addChore(vault, { name: "A", days: [1] }, at("2026-11-01"));
    const b = await addChore(vault, { name: "B", days: [1] }, at("2026-11-02"));
    await deleteChore(vault, a.id);
    const c = await addChore(vault, { name: "C", days: [1] }, at("2026-11-03"));
    const before = {
      b: await assigneeForDate(vault, b.id, "2026-11-09"),
      c: await assigneeForDate(vault, c.id, "2026-11-09"),
    };
    expect(before).toEqual({ b: "Ada", c: "Grace" }); // slots 1 and 2, week 1
    const reloaded = await unlockVault({ store, crypto, now: () => new Date() }, "test passphrase");
    expect(await assigneeForDate(reloaded, b.id, "2026-11-09")).toBe(before.b);
    expect(await assigneeForDate(reloaded, c.id, "2026-11-09")).toBe(before.c);
    expect((await getChoreChart(reloaded))!.slots).toEqual([a.id, b.id, c.id]); // tombstone kept
  });

  it("a nested unknown field inside an era refuses writes and is preserved byte-for-byte", async () => {
    const vault = await freshVault();
    const original = {
      id: "chore-chart",
      rotations: [{ effectiveWeek: "2026-11-01", people: ["Ada"], futureField: "preserve" }],
      overrides: [],
      slots: [],
      schemaVersion: 1,
    };
    await vault.putJson("chore", "chore-chart", original);
    await expect(addChorePerson(vault, "Grace", at("2026-11-01"))).rejects.toThrow(/can't read/);
    await expect(addChore(vault, { name: "A", days: [1] }, at("2026-11-01"))).rejects.toThrow(/can't read/);
    expect(await vault.getJson("chore-chart")).toEqual(original);
  });

  it("a nested unknown field inside a switch refuses writes and is preserved", async () => {
    const vault = await freshVault();
    const original = {
      id: "chore-chart",
      rotations: [{ effectiveWeek: "2026-11-01", people: ["Ada"] }],
      overrides: [{ choreId: "chore:1", date: "2026-11-02", person: "Ada", futureFlag: true }],
      slots: [],
      schemaVersion: 1,
    };
    await vault.putJson("chore", "chore-chart", original);
    await expect(addChorePerson(vault, "Grace", at("2026-11-01"))).rejects.toThrow(/can't read/);
    expect(await vault.getJson("chore-chart")).toEqual(original);
  });
});

describe("slot reservation interleavings", () => {
  it("parallel first chore and first roster setup retain a durable slot", async () => {
    const vault = await freshVault();
    const [a] = await Promise.all([
      addChore(vault, { name: "A", days: [1] }, deps()),
      addChorePerson(vault, "Ada", deps()),
    ]);
    expect((await getChoreChart(vault))!.slots).toEqual([a.id]);
    expect(await assigneeForDate(vault, a.id, "2026-11-02")).toBe("Ada");
  });

  it("parallel chore adds reserve distinct slots and deletion preserves survivors", async () => {
    const vault = await freshVault();
    await addChorePerson(vault, "Ada", deps());
    await addChorePerson(vault, "Grace", deps());
    const [a, b] = await Promise.all([
      addChore(vault, { name: "A", days: [1] }, deps()),
      addChore(vault, { name: "B", days: [1] }, deps()),
    ]);
    const slots = (await getChoreChart(vault))!.slots;
    expect(new Set(slots).size).toBe(2);
    expect(slots).toContain(a.id);
    expect(slots).toContain(b.id);
    const before = await assigneeForDate(vault, b.id, "2026-11-02");
    await deleteChore(vault, a.id);
    expect(await assigneeForDate(vault, b.id, "2026-11-02")).toBe(before);
  });

  it("failed chore write leaves a non-reused tombstone, never a visible chore", async () => {
    const vault = await freshVault();
    const failing = new Proxy(vault, { get(target, prop) {
      if (prop === "putJson") return async () => { throw new Error("write unavailable"); };
      return Reflect.get(target, prop);
    } });
    await expect(addChore(failing, { name: "Failed", days: [1] }, deps())).rejects.toThrow("write unavailable");
    expect(await listChores(vault)).toEqual([]);
    const reserved = (await getChoreChart(vault))!.slots;
    expect(reserved).toHaveLength(1);
    const b = await addChore(vault, { name: "B", days: [1] }, deps());
    expect((await getChoreChart(vault))!.slots).toEqual([...reserved, b.id]);
    expect(await listChorePeople(vault)).toEqual([]);
  });

  it("a legacy slotless chart materializes all slots before deleting one", async () => {
    const vault = await freshVault();
    const a = await addChore(vault, { name: "A", days: [1] }, deps());
    const b = await addChore(vault, { name: "B", days: [1] }, deps());
    await vault.putJson("chore", "chore-chart", {
      id: "chore-chart", rotations: [{ effectiveWeek: "2026-11-01", people: ["Ada", "Grace"] }],
      overrides: [], schemaVersion: 1,
    });
    const before = await assigneeForDate(vault, b.id, "2026-11-02");
    await deleteChore(vault, a.id);
    expect((await getChoreChart(vault))!.slots).toEqual([a.id, b.id]);
    expect(await assigneeForDate(vault, b.id, "2026-11-02")).toBe(before);
  });
});
