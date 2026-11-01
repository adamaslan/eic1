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

/** Deletes one entry by id. Only journal records can be deleted: any other record id is
 * rejected, so a caller can never use this to delete non-journal data. A missing entry is a no-op. */
export async function deleteJournalEntry(vault: UnlockedVault, id: string): Promise<void> {
  const existing = await vault.getJson(id);
  if (existing === null) return;
  if (!JournalEntrySchema.safeParse(existing).success) throw new AppError("That entry does not exist.");
  await vault.deleteRecords([id]);
}

/** Case-insensitive substring filter; blank query returns everything. */
export function filterJournal(entries: JournalEntry[], query: string): JournalEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.text.toLowerCase().includes(needle));
}
