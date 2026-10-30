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
