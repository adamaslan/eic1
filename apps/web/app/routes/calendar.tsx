import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  AppError,
  CALENDAR_NOTE_MAX,
  CALENDAR_TITLE_MAX,
  WEEKDAY_LABELS,
  dateFromKey,
  localDateKey,
  monthGrid,
  monthLabel,
  type CalendarEvent,
} from "@veil/core";
import { addCalendarEvent, deleteCalendarEvent, listCalendarEvents } from "@veil/features";
import type { Route } from "./+types/calendar";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Calendar — Everybody is Cool" }];
}

function dayLabel(key: string): string {
  return dateFromKey(key).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export default function Calendar() {
  const vault = useSessionStore((state) => state.vault);
  const todayKey = localDateKey(new Date());
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    if (!vault) return false;
    try {
      setEvents(await listCalendarEvents(vault));
      return true;
    } catch {
      setError("The calendar could not be read.");
      return false;
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events ?? []) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [events]);

  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);
  const selectedEvents = byDay.get(selectedKey) ?? [];

  function shiftMonth(delta: number) {
    setView((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  function goToday() {
    const now = new Date();
    setView({ year: now.getFullYear(), month: now.getMonth() });
    setSelectedKey(localDateKey(now));
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!vault || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await addCalendarEvent(vault, { title, date: selectedKey, time: time || null, note }, { newId: newItemId, now: new Date() });
      // The encrypted write landed: clear the form, then confirm explicitly.
      // If the refresh read fails afterwards the record is still saved - say so
      // rather than hinting at a failure that would tempt a duplicate submit.
      setTitle("");
      setTime("");
      setNote("");
      const refreshed = await reload();
      setNotice(refreshed ? "Event saved to your encrypted vault." : "Event saved to your encrypted vault, but the list couldn't refresh.");
    } catch (caught) {
      // Pre-write failure: the input stays untouched so nothing is lost.
      setError(caught instanceof AppError ? caught.message : "The event could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!vault || deletingId) return;
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      await deleteCalendarEvent(vault, id);
      const refreshed = await reload();
      setNotice(refreshed ? "Event deleted." : "Event deleted, but the list couldn't refresh.");
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The event could not be deleted. Please try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Window title={`Calendar — ${monthLabel(view.year, view.month)}`}>
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <Button95 onClick={() => shiftMonth(-1)} aria-label="Previous month">◀</Button95>
          <Button95 onClick={goToday}>Today</Button95>
          <Button95 onClick={() => shiftMonth(1)} aria-label="Next month">▶</Button95>
          <span className="ml-auto text-[11px] text-[#404040]">Events stay in this vault.</span>
        </div>
        <div role="grid" aria-label={`${monthLabel(view.year, view.month)} days`} className="text-[12px]">
          <div role="row" className="grid grid-cols-7 gap-px bg-[#808080]">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} role="columnheader" className="bg-[#c0c0c0] px-1 py-0.5 text-center font-bold">
                {label}
              </div>
            ))}
          </div>
          {grid.map((week) => (
            <div role="row" key={week[0]!.key} className="grid grid-cols-7 gap-px bg-[#808080]">
              {week.map((cell) => {
                const dayEvents = byDay.get(cell.key) ?? [];
                const selected = cell.key === selectedKey;
                const today = cell.key === todayKey;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    role="gridcell"
                    aria-selected={selected}
                    aria-label={`${dayLabel(cell.key)}, ${dayEvents.length === 0 ? "no events" : `${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}`}
                    onClick={() => setSelectedKey(cell.key)}
                    className={`flex min-h-[44px] cursor-pointer flex-col items-start px-1 py-0.5 text-left sm:min-h-[40px] ${
                      selected ? "bg-[#000080] text-white" : cell.inMonth ? "bg-white text-[#0a0a0a]" : "bg-[#dfdfdf] text-[#808080]"
                    }`}
                  >
                    <span className={today ? "font-bold underline" : ""}>{cell.day}</span>
                    {dayEvents.length > 0 && (
                      <span className="text-[11px]">• {dayEvents.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Window>

      <Window title={`${dayLabel(selectedKey)}${selectedEvents.length ? ` (${selectedEvents.length})` : ""}`}>
        {events === null ? (
          <p className="text-[12px]">Loading…</p>
        ) : selectedEvents.length === 0 ? (
          <p className="text-[12px]">Nothing planned for this day.</p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1 text-[12px]">
            {selectedEvents.map((event) => (
              <li key={event.id} className="flex items-start gap-2 bg-white px-1.5 py-1">
                <div className="min-w-0 flex-1">
                  <p>
                    {event.time && <span className="font-bold">{event.time} </span>}
                    {event.title}
                  </p>
                  {event.note && <p className="whitespace-pre-wrap text-[11px] text-[#404040]">{event.note}</p>}
                </div>
                <Button95 onClick={() => void remove(event.id)} disabled={deletingId === event.id} aria-label={`Delete ${event.title}`}>
                  {deletingId === event.id ? "…" : "✕"}
                </Button95>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={save} className="flex flex-col gap-2 border-t border-[#808080] pt-2 text-[12px] text-[#0a0a0a]">
          <p className="font-bold">Add to {dayLabel(selectedKey)}</p>
          <label htmlFor="calendar-title" className="sr-only">Event title</label>
          <input
            id="calendar-title"
            type="text"
            maxLength={CALENDAR_TITLE_MAX}
            value={title}
            onChange={(change) => { setTitle(change.target.value); setNotice(null); }}
            placeholder="Title"
            className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="flex items-center gap-2">
            <label htmlFor="calendar-time">Time</label>
            <input
              id="calendar-time"
              type="time"
              value={time}
              onChange={(change) => { setTime(change.target.value); setNotice(null); }}
              className="bg-white px-1.5 py-1 text-[12px] outline-none"
            />
            <span className="text-[11px] text-[#404040]">optional</span>
          </div>
          <label htmlFor="calendar-note" className="sr-only">Note</label>
          <textarea
            id="calendar-note"
            rows={2}
            maxLength={CALENDAR_NOTE_MAX}
            value={note}
            onChange={(change) => { setNote(change.target.value); setNotice(null); }}
            placeholder="Note (optional)"
            className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
          />
          <div>
            <Button95 type="submit" disabled={saving || !title.trim()}>{saving ? "Encrypting…" : "🔒 Save event"}</Button95>
          </div>
          {notice && <p role="status" className="text-[#008000]">{notice}</p>}
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
        </form>
        <p className="mt-2 text-[12px]">
          <Link to="/tools" className="text-[#0000cc] underline">Back to tools</Link>
        </p>
      </Window>
    </div>
  );
}
