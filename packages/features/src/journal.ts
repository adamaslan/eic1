import { AppError, JOURNAL_ENTRY_MAX, JournalEntrySchema, type JournalEntry } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

/** Newest first. A record that fails validation or cannot be decrypted is skipped so one bad entry never hides the rest. */
export async function listJournal(vault: UnlockedVault): Promise<JournalEntry[]> {
  const raw = await vault.listJson("journal", { skipUndecryptable: true });
  const entries: JournalEntry[] = [];
  for (const value of raw) {
    const parsed = JournalEntrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addJournalEntry(
  vault: UnlockedVault,
  text: string,
  deps: { newId: () => string; now: Date },
): Promise<JournalEntry> {
  const clean = text.trim();
  if (!clean) throw new AppError("Write something first.");
  if (clean.length > JOURNAL_ENTRY_MAX) throw new AppError(`Keep an entry under ${JOURNAL_ENTRY_MAX} characters.`);
  const entry = JournalEntrySchema.parse({
    id: `journal:${deps.newId()}`,
    text: clean,
    createdAt: deps.now.toISOString(),
    schemaVersion: 1,
  });
  await vault.putJson("journal", entry.id, entry);
  return entry;
}

/** Edits an entry in place: same id and original timestamp, new text. */
export async function updateJournalEntry(vault: UnlockedVault, id: string, text: string): Promise<JournalEntry> {
  const existing = JournalEntrySchema.safeParse(await vault.getJson(id));
  if (!existing.success) throw new AppError("That entry does not exist.");
  const clean = text.trim();
  if (!clean) throw new AppError("Write something first.");
  if (clean.length > JOURNAL_ENTRY_MAX) throw new AppError(`Keep an entry under ${JOURNAL_ENTRY_MAX} characters.`);
  const updated = JournalEntrySchema.parse({ ...existing.data, text: clean });
  await vault.putJson("journal", updated.id, updated);
  return updated;
}

/** Deletes one entry by id. Deleting an entry that is not there is a no-op. */
export async function deleteJournalEntry(vault: UnlockedVault, id: string): Promise<void> {
  await vault.deleteRecords([id]);
}

/** Case-insensitive substring filter; blank query returns everything. */
export function filterJournal(entries: JournalEntry[], query: string): JournalEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.text.toLowerCase().includes(needle));
}

/** Date windows for the journal filter. "all" keeps everything; the others keep entries whose timestamp is inside a rolling window ending at `now`. */
export type JournalDateRange = "all" | "day" | "week" | "month";

export const JOURNAL_DATE_RANGES: { id: JournalDateRange; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "day", label: "Last 24 hours" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
];

const RANGE_MS: Record<Exclude<JournalDateRange, "all">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** Keeps entries created at or after the window cutoff. An entry exactly at the cutoff still counts. */
export function filterJournalByDate(entries: JournalEntry[], range: JournalDateRange, now: Date): JournalEntry[] {
  if (range === "all") return entries;
  const cutoff = now.getTime() - RANGE_MS[range];
  // JournalEntrySchema validates createdAt as an ISO datetime before entries reach this selector.
  return entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff);
}

export interface JournalFilter {
  query: string;
  range: JournalDateRange;
}

export const emptyJournalFilter: JournalFilter = { query: "", range: "all" };

export function isJournalFilterActive(filter: JournalFilter): boolean {
  return filter.query.trim() !== "" || filter.range !== "all";
}

export interface FilteredJournal {
  entries: JournalEntry[];
  /** Total entries before filtering, for "Showing X of Y" copy. */
  total: number;
}

/** Text first, then date: a date window never widens a text search, only narrows it. */
export function applyJournalFilters(entries: JournalEntry[], filter: JournalFilter, now: Date): FilteredJournal {
  const byText = filterJournal(entries, filter.query);
  return { entries: filterJournalByDate(byText, filter.range, now), total: entries.length };
}
