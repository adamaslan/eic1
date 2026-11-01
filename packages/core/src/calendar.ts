import { z } from "zod";

export const CALENDAR_TITLE_MAX = 120;
export const CALENDAR_NOTE_MAX = 500;
export const CHORE_NAME_MAX = 60;

/** Local day identity, YYYY-MM-DD. Always produced by localDateKey so it never shifts with UTC. */
const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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

/** Local YYYY-MM-DD for a Date in the device's own timezone (never UTC-shifted). */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Noon local time on the given key, so calendar math never crosses a DST midnight. */
export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The 7 local dates (Sunday first) of the week containing `date`. */
export function weekOf(date: Date): Date[] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
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

export interface MonthCell {
  key: string;
  day: number;
  weekday: number;
  inMonth: boolean;
}

/** Six rows of 7 cells (Sunday first) covering the given month, so the grid keeps a stable height. */
export function monthGrid(year: number, month: number): MonthCell[][] {
  const first = new Date(year, month, 1, 12);
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

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleString([], { month: "long", year: "numeric" });
}
