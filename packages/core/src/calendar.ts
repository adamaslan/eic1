import { z } from "zod";

export const CALENDAR_TITLE_MAX = 120;
export const CALENDAR_NOTE_MAX = 500;
export const CHORE_NAME_MAX = 60;

/** Local day identity, YYYY-MM-DD. Always produced by localDateKey so it never shifts with UTC. */
const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDateKey, "Not a real calendar date");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(CALENDAR_TITLE_MAX),
  date: dateKeySchema,
  // null means all-day / untimed.
  time: timeSchema.nullable().default(null),
  note: z.string().max(CALENDAR_NOTE_MAX).default(""),
  createdAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const ChoreSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(CHORE_NAME_MAX),
  // Weekdays the chore is expected on (0 = Sunday). A full 0-6 list means every day.
  days: z.array(z.number().int().min(0).max(6)).max(7),
  // Local date keys the chore was checked off.
  done: z.array(dateKeySchema).default([]),
  createdAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
});
export type Chore = z.infer<typeof ChoreSchema>;

export const CHORE_PERSON_NAME_MAX = 40;
/** The chart plans a rotating roster at most this many weeks past the current one. */
export const CHORE_ROTATION_WEEKS = 8;

/** A people list and the Sunday date key it takes effect. Past weeks keep earlier lists. */
export const ChoreRotationSchema = z.object({
  effectiveWeek: dateKeySchema,
  people: z.array(z.string().min(1).max(CHORE_PERSON_NAME_MAX)).min(1).max(12),
}).strict();
/** A manual switch: one chore, one date, one name. Wins over the rotation for that date only. */
export const ChoreOverrideSchema = z.object({
  choreId: z.string().min(1),
  date: dateKeySchema,
  person: z.string().min(1).max(CHORE_PERSON_NAME_MAX),
}).strict();
export const ChoreChartSchema = z.object({
  id: z.literal("chore-chart"),
  rotations: z.array(ChoreRotationSchema),
  overrides: z.array(ChoreOverrideSchema).default([]),
  // Stable rotation slots in vault creation order. Deleted chores stay as tombstones so
  // the remaining chores never renumber - a delete must not rewrite anyone's week.
  slots: z.array(z.string().min(1)).default([]),
  schemaVersion: z.literal(1),
});
export type ChoreRotation = z.infer<typeof ChoreRotationSchema>;
export type ChoreOverride = z.infer<typeof ChoreOverrideSchema>;
export type ChoreChart = z.infer<typeof ChoreChartSchema>;

/** Local YYYY-MM-DD for a Date in the device's own timezone (never UTC-shifted). */
export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Noon local time on the given calendar day. setFullYear keeps years 0-99 out of the 1900s,
 * and noon keeps calendar math clear of DST midnights.
 */
function noonOn(year: number, monthIndex: number, day: number): Date {
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, monthIndex, day);
  return date;
}

/** Noon local time on the given key, so calendar math never crosses a DST midnight. */
export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return noonOn(year!, month! - 1, day!);
}

/**
 * True only for keys naming a real Gregorian day. Pure arithmetic, no Date, so the answer
 * never depends on the reader's timezone: a day skipped by a zone's DST change is still a
 * real day, and a stored event on it must still parse.
 */
export function isRealDateKey(key: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The 7 local dates (Sunday first) of the week containing `date`. */
export function weekOf(date: Date): Date[] {
  const start = noonOn(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Sunday key of the week containing the given date key. */
export function weekStartKey(key: string): string {
  return localDateKey(weekOf(dateFromKey(key))[0]!);
}

/** Whole weeks between two Sunday week keys; negative when the anchor is later. */
export function weeksBetween(anchorWeekKey: string, weekKey: string): number {
  const ms = dateFromKey(weekKey).getTime() - dateFromKey(anchorWeekKey).getTime();
  return Math.round(ms / (7 * 24 * 60 * 60 * 1000));
}

/**
 * The people list in effect for a week: the latest rotation at or before it.
 * Null for any week before the first registered week - the chart never assigns
 * people into a past that predates the list that would produce them.
 */
export function rotationForWeek(chart: ChoreChart, weekKey: string): ChoreRotation | null {
  const sorted = [...chart.rotations].sort((a, b) => a.effectiveWeek.localeCompare(b.effectiveWeek));
  if (sorted.length === 0 || weekKey < sorted[0]!.effectiveWeek) return null;
  let active: ChoreRotation | null = null;
  for (const rotation of sorted) {
    if (rotation.effectiveWeek <= weekKey) active = rotation;
  }
  return active;
}

/**
 * A chore's stable rotation slot. Persisted slots never renumber (deleted chores stay as
 * tombstones); a chore not yet recorded takes the next slot after the persisted ones, in
 * the order listChores returns. -1 when the chore is not in the given list.
 */
export function choreSlot(chart: ChoreChart, chores: Chore[], choreId: string): number {
  const recorded = chart.slots.indexOf(choreId);
  if (recorded !== -1) return recorded;
  let extra = 0;
  for (const chore of chores) {
    if (chart.slots.includes(chore.id)) continue;
    if (chore.id === choreId) return chart.slots.length + extra;
    extra += 1;
  }
  return -1;
}

/**
 * The rotated name for a chore in a week: slot advances one person per week, in order.
 * Slots are the chart's creation order, so each person's chores change sequentially.
 * Null when the chart has no people yet.
 */
export function rotatedPerson(chart: ChoreChart, weekKey: string, slot: number): string | null {
  const rotation = rotationForWeek(chart, weekKey);
  if (!rotation || rotation.people.length === 0) return null;
  const weeks = Math.max(0, weeksBetween(rotation.effectiveWeek, weekKey));
  return rotation.people[(slot + weeks) % rotation.people.length] ?? null;
}

export interface MonthCell {
  key: string;
  day: number;
  weekday: number;
  inMonth: boolean;
}

/** Six rows of 7 cells (Sunday first) covering the given month, so the grid keeps a stable height. */
export function monthGrid(year: number, month: number): MonthCell[][] {
  const first = noonOn(year, month, 1);
  const start = addDays(first, -first.getDay());
  const rows: MonthCell[][] = [];
  for (let week = 0; week < 6; week++) {
    const row: MonthCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = addDays(start, week * 7 + weekday);
      row.push({
        key: localDateKey(date),
        day: date.getDate(),
        weekday,
        inMonth: date.getMonth() === month,
      });
    }
    rows.push(row);
  }
  return rows;
}

/** Year 0000 is 1 BC; without the era, it would read the same as year 0001. */
export function monthLabel(year: number, month: number): string {
  const era = year < 1 ? { era: "short" as const } : {};
  return noonOn(year, month, 1).toLocaleString([], { month: "long", year: "numeric", ...era });
}
