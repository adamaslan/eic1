import {
  AppError,
  CALENDAR_NOTE_MAX,
  CALENDAR_TITLE_MAX,
  CHORE_NAME_MAX,
  CalendarEventSchema,
  ChoreSchema,
  dateFromKey,
  type CalendarEvent,
  type Chore,
} from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

/**
 * Calendar events and chores are private device data: they live only in this
 * vault and are never put in a share file.
 */

/** Sorted by day, then untimed first, then by time. Bad records are skipped, never fatal. */
export async function listCalendarEvents(vault: UnlockedVault): Promise<CalendarEvent[]> {
  const raw = await vault.listJson("calendar", { skipUndecryptable: true });
  const events: CalendarEvent[] = [];
  for (const value of raw) {
    const parsed = CalendarEventSchema.safeParse(value);
    if (parsed.success) events.push(parsed.data);
  }
  return events.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.createdAt.localeCompare(b.createdAt),
  );
}

export async function addCalendarEvent(
  vault: UnlockedVault,
  input: { title: string; date: string; time?: string | null; note?: string },
  deps: { newId: () => string; now: Date },
): Promise<CalendarEvent> {
  const title = input.title.trim();
  if (!title) throw new AppError("Give the event a title.");
  if (title.length > CALENDAR_TITLE_MAX) throw new AppError(`Keep the title under ${CALENDAR_TITLE_MAX} characters.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(dateFromKey(input.date).getTime())) {
    throw new AppError("Pick a real date.");
  }
  const note = (input.note ?? "").trim();
  if (note.length > CALENDAR_NOTE_MAX) throw new AppError(`Keep the note under ${CALENDAR_NOTE_MAX} characters.`);
  const event = CalendarEventSchema.parse({
    id: `calendar:${deps.newId()}`,
    title,
    date: input.date,
    time: input.time || null,
    note,
    createdAt: deps.now.toISOString(),
    schemaVersion: 1,
  });
  await vault.putJson("calendar", event.id, event);
  return event;
}

/** Deletes only after the record parses as a calendar event, so a mistargeted id can never drop another kind. */
export async function deleteCalendarEvent(vault: UnlockedVault, id: string): Promise<void> {
  const existing = await vault.getJson(id);
  const parsed = CalendarEventSchema.safeParse(existing);
  if (!parsed.success) throw new AppError("That calendar entry no longer exists.");
  await vault.deleteRecords([id]);
}

/** Oldest first so the chart keeps a stable row order. Bad records are skipped. */
export async function listChores(vault: UnlockedVault): Promise<Chore[]> {
  const raw = await vault.listJson("chore", { skipUndecryptable: true });
  const chores: Chore[] = [];
  for (const value of raw) {
    const parsed = ChoreSchema.safeParse(value);
    if (parsed.success) chores.push(parsed.data);
  }
  return chores.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addChore(
  vault: UnlockedVault,
  input: { name: string; days: number[] },
  deps: { newId: () => string; now: Date },
): Promise<Chore> {
  const name = input.name.trim();
  if (!name) throw new AppError("Give the chore a name.");
  if (name.length > CHORE_NAME_MAX) throw new AppError(`Keep the name under ${CHORE_NAME_MAX} characters.`);
  const days = [...new Set(input.days)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
  if (days.length === 0) throw new AppError("Pick at least one day for the chore.");
  const chore = ChoreSchema.parse({
    id: `chore:${deps.newId()}`,
    name,
    days,
    done: [],
    createdAt: deps.now.toISOString(),
    schemaVersion: 1,
  });
  await vault.putJson("chore", chore.id, chore);
  return chore;
}

export async function deleteChore(vault: UnlockedVault, id: string): Promise<void> {
  const existing = await vault.getJson(id);
  const parsed = ChoreSchema.safeParse(existing);
  if (!parsed.success) throw new AppError("That chore no longer exists.");
  await vault.deleteRecords([id]);
}

/** Flips one day's check-off. Re-reads the chore first so a stale row cannot resurrect old check-offs. */
export async function toggleChoreDone(vault: UnlockedVault, id: string, dateKey: string): Promise<Chore> {
  const existing = await vault.getJson(id);
  const parsed = ChoreSchema.safeParse(existing);
  if (!parsed.success) throw new AppError("That chore no longer exists.");
  const chore = parsed.data;
  const done = chore.done.includes(dateKey) ? chore.done.filter((key) => key !== dateKey) : [...chore.done, dateKey];
  const updated: Chore = { ...chore, done };
  await vault.putJson("chore", chore.id, updated);
  return updated;
}
