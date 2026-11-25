import { describe, expect, it } from "vitest";
import type { JournalEntry } from "@veil/core";
import { applyJournalFilters, filterJournalByDate, type JournalDateRange } from "./journal";

const now = new Date("2026-11-24T12:00:00.000Z");
const entry = (id: string, timestamp: number): JournalEntry => ({
  id: `journal:${id}`, text: `bridge ${id}`, createdAt: new Date(timestamp).toISOString(), schemaVersion: 1,
});

for (const [range, days] of [["day", 1], ["week", 7], ["month", 30]] as const) {
  describe(`${range} rolling window`, () => {
    const cutoff = now.getTime() - days * 86_400_000;
    const entries = [entry("future", now.getTime() + 1), entry("now", now.getTime()),
      entry("boundary", cutoff), entry("old", cutoff - 1)];
    it("includes both boundaries and excludes future entries without changing input", () => {
      const before = structuredClone(entries);
      expect(filterJournalByDate(entries, range, now).map((item) => item.id))
        .toEqual(["journal:now", "journal:boundary"]);
      expect(entries).toEqual(before);
    });
    it("preserves the text/date intersection and original total", () => {
      const result = applyJournalFilters(entries, { query: "bridge", range }, now);
      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(4);
    });
  });
}

it("keeps future entries available under All time", () => {
  const entries = [entry("future", now.getTime() + 1)];
  expect(filterJournalByDate(entries, "all" as JournalDateRange, now)).toBe(entries);
});
