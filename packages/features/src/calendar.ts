import {
  AppError,
  CALENDAR_NOTE_MAX,
  CALENDAR_TITLE_MAX,
  CHORE_NAME_MAX,
  CHORE_PERSON_NAME_MAX,
  CalendarEventSchema,
  ChoreChartSchema,
  ChoreRotationSchema,
  ChoreSchema,
  addDays,
  choreSlot,
  dateFromKey,
  isRealDateKey,
  localDateKey,
  rotatedPerson,
  rotationForWeek,
  weekOf,
  weekStartKey,
  type CalendarEvent,
  type Chore,
  type ChoreChart,
} from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

/**
 * Calendar events and chores are private device data: they live only in this
 * vault and are never put in a share file.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  if (!isRealDateKey(input.date)) throw new AppError("Pick a real date.");
  const time = input.time || null;
  if (time !== null && !TIME_PATTERN.test(time)) throw new AppError("Pick a real time, or leave it empty for all day.");
  const note = (input.note ?? "").trim();
  if (note.length > CALENDAR_NOTE_MAX) throw new AppError(`Keep the note under ${CALENDAR_NOTE_MAX} characters.`);
  const event = CalendarEventSchema.parse({
    id: `calendar:${deps.newId()}`,
    title,
    date: input.date,
    time,
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
  const id = `chore:${deps.newId()}`;
  // Reserve the stable slot through the same CAS as roster edits, even before
  // anyone joins. This closes the absent-chart / first-person setup race. The
  // slot is durable before the chore becomes visible. A failed chore write leaves
  // only an inert tombstone; the slot is never reused.
  await saveChoreChart(vault, async (chart) => {
    const slots = reconcileSlots(chart, await listChores(vault));
    return {
      id: "chore-chart", rotations: chart?.rotations ?? [], overrides: chart?.overrides ?? [],
      slots: slots.includes(id) ? slots : [...slots, id], schemaVersion: 1,
    };
  });
  const chore = ChoreSchema.parse({
    id,
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
  // Materialize legacy slots before removing a chore from the live list. All
  // new adds reserve first, so concurrent adds cannot be lost by this CAS retry.
  await saveChoreChart(vault, async (chart) => ({
    id: "chore-chart", rotations: chart?.rotations ?? [], overrides: chart?.overrides ?? [],
    slots: reconcileSlots(chart, await listChores(vault)), schemaVersion: 1,
  }));
  await vault.deleteRecords([id]);
}

/** Flips one day's check-off. Compare-and-swap with one retry: two tabs can hold the same vault
 *  unlocked, and a plain read-modify-write would silently drop one side's check-off. */
export async function toggleChoreDone(vault: UnlockedVault, id: string, dateKey: string): Promise<Chore> {
  if (!isRealDateKey(dateKey)) throw new AppError("That day does not exist.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await vault.getJson(id);
    const parsed = ChoreSchema.safeParse(existing);
    if (!parsed.success) throw new AppError("That chore no longer exists.");
    const chore = parsed.data;
    const done = chore.done.includes(dateKey) ? chore.done.filter((key) => key !== dateKey) : [...chore.done, dateKey];
    const updated: Chore = { ...chore, done };
    try {
      await vault.putJsonIfUnchanged("chore", chore.id, updated, existing);
      return updated;
    } catch (err) {
      if (attempt === 1) {
        throw err instanceof AppError
          ? new AppError("That chore changed in another tab before this check-off saved. Nothing was overwritten. Try again.")
          : err;
      }
    }
  }
  throw new AppError("That chore changed in another tab before this check-off saved. Nothing was overwritten. Try again.");
}

const CHORE_CHART_ID = "chore-chart";

/** Chart metadata, or null when no chart metadata exists. Unsupported records fail closed. */
export async function getChoreChart(vault: UnlockedVault): Promise<ChoreChart | null> {
  return parseChartRecord(await vault.getJson(CHORE_CHART_ID));
}

/** The people on the chart right now (the latest rotation's list), oldest first. */
export async function listChorePeople(vault: UnlockedVault): Promise<string[]> {
  const chart = await getChoreChart(vault);
  if (!chart) return [];
  const sorted = [...chart.rotations].sort((a, b) => a.effectiveWeek.localeCompare(b.effectiveWeek));
  return sorted[sorted.length - 1]?.people ?? [];
}

const CHART_UNREADABLE =
  "The chore chart is in a format this version of the app can't read. The chart's data is untouched. This app can't safely change its roster or assignments.";

/**
 * Parse a stored chart record, failing closed. A record this version cannot parse -
 * wrong schemaVersion, unknown keys, malformed fields - is never treated as absent and
 * never overwritten; every read and write refuses instead of risking data loss.
 */
function parseChartRecord(existing: unknown): ChoreChart | null {
  if (existing === undefined || existing === null) return null;
  const parsed = ChoreChartSchema.strict().safeParse(existing);
  if (!parsed.success) throw new AppError(CHART_UNREADABLE);
  return parsed.data;
}

/** Persisted slots plus every live chore not yet recorded, in listChores order. Tombstones stay. */
function reconcileSlots(chart: ChoreChart | null, chores: { id: string }[]): string[] {
  const slots = chart?.slots ?? [];
  return [...slots, ...chores.map((chore) => chore.id).filter((id) => !slots.includes(id))];
}

/** CAS-write the chart so two unlocked tabs cannot drop each other's people or switches. */
async function saveChoreChart(vault: UnlockedVault, next: (chart: ChoreChart | null) => Promise<ChoreChart>): Promise<ChoreChart> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await vault.getJson(CHORE_CHART_ID);
    const current = parseChartRecord(existing);
    const updated = ChoreChartSchema.parse(await next(current));
    try {
      // Kind "chore" so backups and exports sweep the chart with the chart's chores;
      // listChores skips it because it is not a Chore. The id can never collide (no colon).
      await vault.putJsonIfUnchanged("chore", CHORE_CHART_ID, updated, existing);
      return updated;
    } catch (err) {
      if (attempt === 1) {
        throw err instanceof AppError
          ? new AppError("The chore chart changed in another tab before this saved. Nothing was overwritten. Try again.")
          : err;
      }
    }
  }
  throw new AppError("The chore chart could not be saved. Please try again.");
}

/**
 * Adds a name to the chart. In-place amendment is allowed only where no already-displayed
 * week can change: the very first list during its own setup week, or a future list that
 * has not started yet. Any other addition takes effect NEXT week - the current week's
 * names, and every past day, stay exactly as they were.
 */
export async function addChorePerson(
  vault: UnlockedVault,
  input: string,
  deps: { now: Date },
): Promise<ChoreChart> {
  const name = input.trim();
  if (!name) throw new AppError("Give the person a name.");
  if (name.length > CHORE_PERSON_NAME_MAX) throw new AppError(`Keep the name under ${CHORE_PERSON_NAME_MAX} characters.`);
  const thisWeekStart = weekOf(deps.now)[0]!;
  const thisWeek = localDateKey(thisWeekStart);
  const nextWeek = localDateKey(addDays(thisWeekStart, 7));
  return saveChoreChart(vault, async (chart) => {
    const chores = await listChores(vault);
    const slots = reconcileSlots(chart, chores);
    const sorted = [...(chart?.rotations ?? [])].sort((a, b) => a.effectiveWeek.localeCompare(b.effectiveWeek));
    const latest = sorted[sorted.length - 1];
    const current = latest?.people ?? [];
    if (current.some((person) => person.toLowerCase() === name.toLowerCase())) {
      throw new AppError(`${name} is already on the chart.`);
    }
    const initialSetup = sorted.length === 1 && latest!.effectiveWeek === thisWeek;
    const pendingFuture = latest !== undefined && latest.effectiveWeek > thisWeek;
    if (latest && (initialSetup || pendingFuture)) {
      const amended = ChoreRotationSchema.parse({ ...latest, people: [...latest.people, name] });
      return { id: "chore-chart", rotations: [...sorted.slice(0, -1), amended], overrides: chart?.overrides ?? [], slots, schemaVersion: 1 };
    }
    const effectiveWeek = latest ? nextWeek : thisWeek;
    const rotation = ChoreRotationSchema.parse({ effectiveWeek, people: [...current, name] });
    return { id: "chore-chart", rotations: [...sorted, rotation], overrides: chart?.overrides ?? [], slots, schemaVersion: 1 };
  });
}

/** Switches one chore's name for one date. The rotation and the rest of the week stay put. */
export async function setChoreOverride(
  vault: UnlockedVault,
  choreId: string,
  dateKey: string,
  person: string,
  deps: { now: Date },
): Promise<ChoreChart> {
  if (!isRealDateKey(dateKey)) throw new AppError("Pick a real date for the switch.");
  const existing = await vault.getJson(choreId);
  const parsedChore = ChoreSchema.safeParse(existing);
  if (!parsedChore.success) throw new AppError("That chore no longer exists.");
  if (dateKey < localDateKey(new Date(parsedChore.data.createdAt))) {
    throw new AppError("That date is before the chore was added.");
  }
  void deps;
  return saveChoreChart(vault, async (chart) => {
    if (!chart) throw new AppError("Add a person to the chart first.");
    const chores = await listChores(vault);
    const slots = reconcileSlots(chart, chores);
    // Validate against the week the switch lands on, not the current week: a person whose
    // list starts next week is selectable for those future dates, and no one is selectable
    // for a week before the chart had people at all.
    const era = rotationForWeek(chart, weekStartKey(dateKey));
    if (!era) throw new AppError("The chart had no people for that week.");
    if (!era.people.includes(person)) throw new AppError(`${person} is not on the chart for that week. Add them first.`);
    const overrides = [...chart.overrides.filter((entry) => !(entry.choreId === choreId && entry.date === dateKey)), { choreId, date: dateKey, person }];
    return { ...chart, overrides, slots };
  });
}

/** Removes a switch; the date goes back to the rotation. */
export async function clearChoreOverride(vault: UnlockedVault, choreId: string, dateKey: string): Promise<void> {
  await saveChoreChart(vault, async (chart) => {
    if (!chart) throw new AppError("There is no switch to remove.");
    const slots = reconcileSlots(chart, await listChores(vault));
    return { ...chart, overrides: chart.overrides.filter((entry) => !(entry.choreId === choreId && entry.date === dateKey)), slots };
  });
}

/**
 * Who has a chore on a date: the manual switch when one exists, else the weekly rotation.
 * Slot = the chore's creation order, so each person's set of chores changes sequentially.
 */
export async function assigneeForDate(vault: UnlockedVault, choreId: string, dateKey: string): Promise<string | null> {
  if (!isRealDateKey(dateKey)) throw new AppError("Pick a real date.");
  const chart = await getChoreChart(vault);
  if (!chart) return null;
  const chores = await listChores(vault);
  const chore = chores.find((entry) => entry.id === choreId);
  if (!chore) throw new AppError("That chore no longer exists.");
  // Never invent an assignee for a day before the chore itself existed.
  if (dateKey < localDateKey(new Date(chore.createdAt))) return null;
  const override = chart.overrides.find((entry) => entry.choreId === choreId && entry.date === dateKey);
  if (override) return override.person;
  return rotatedPerson(chart, weekStartKey(dateKey), choreSlot(chart, chores, choreId));
}

/**
 * One pass over the vault for a displayed week: chore id -> date key -> name.
 * Cells without a scheduled chore or any people simply have no entry.
 */
export async function assignmentsForWeek(vault: UnlockedVault, weekBase: Date): Promise<Map<string, Map<string, string>>> {
  const chart = await getChoreChart(vault);
  const result = new Map<string, Map<string, string>>();
  if (!chart) return result;
  const days = weekOf(weekBase);
  const keys = days.map((day) => localDateKey(day));
  const weekKey = weekStartKey(keys[0]!);
  const chores = await listChores(vault);
  chores.forEach((chore) => {
    const slot = choreSlot(chart, chores, chore.id);
    if (slot === -1) return;
    const rotated = rotatedPerson(chart, weekKey, slot);
    const createdKey = localDateKey(new Date(chore.createdAt));
    for (let index = 0; index < days.length; index += 1) {
      if (!chore.days.includes(days[index]!.getDay())) continue;
      const key = keys[index]!;
      if (key < createdKey) continue;
      const override = chart.overrides.find((entry) => entry.choreId === chore.id && entry.date === key);
      const person = override?.person ?? rotated;
      if (person === null) continue;
      if (!result.has(chore.id)) result.set(chore.id, new Map());
      result.get(chore.id)!.set(key, person);
    }
  });
  return result;
}
