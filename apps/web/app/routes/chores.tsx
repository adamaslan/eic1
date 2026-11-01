import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  AppError,
  CHORE_NAME_MAX,
  WEEKDAY_LABELS,
  addDays,
  localDateKey,
  weekOf,
  type Chore,
} from "@veil/core";
import { addChore, deleteChore, listChores, toggleChoreDone } from "@veil/features";
import type { Route } from "./+types/chores";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Chore chart — Everybody is Cool" }];
}

export default function Chores() {
  const vault = useSessionStore((state) => state.vault);
  const [chores, setChores] = useState<Chore[] | null>(null);
  const [weekBase, setWeekBase] = useState(() => new Date());
  const [name, setName] = useState("");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const week = useMemo(() => weekOf(weekBase), [weekBase]);
  const weekKeys = useMemo(() => week.map(localDateKey), [week]);
  const todayKey = localDateKey(new Date());
  const weekLabel = `${week[0]!.toLocaleDateString([], { month: "short", day: "numeric" })} – ${week[6]!.toLocaleDateString([], { month: "short", day: "numeric" })}`;

  const reload = useCallback(async () => {
    if (!vault) return;
    try {
      setChores(await listChores(vault));
    } catch {
      setError("The chore chart could not be read.");
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function flipDay(day: number) {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!vault || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addChore(vault, { name, days }, { newId: newItemId, now: new Date() });
      setName("");
      setDays([0, 1, 2, 3, 4, 5, 6]);
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The chore could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(chore: Chore, key: string) {
    if (!vault || busyKey) return;
    setBusyKey(`${chore.id}:${key}`);
    setError(null);
    try {
      await toggleChoreDone(vault, chore.id, key);
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The check-off could not be saved. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(chore: Chore) {
    if (!vault || busyKey) return;
    setBusyKey(chore.id);
    setError(null);
    try {
      await deleteChore(vault, chore.id);
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The chore could not be deleted. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Window title={`Chore chart — ${weekLabel}`}>
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <Button95 onClick={() => setWeekBase((base) => addDays(base, -7))} aria-label="Previous week">◀</Button95>
          <Button95 onClick={() => setWeekBase(new Date())}>This week</Button95>
          <Button95 onClick={() => setWeekBase((base) => addDays(base, 7))} aria-label="Next week">▶</Button95>
          <span className="ml-auto text-[11px] text-[#404040]">Check-offs stay in this vault.</span>
        </div>

        {chores === null ? (
          <p className="text-[12px]">Loading…</p>
        ) : chores.length === 0 ? (
          <p className="text-[12px]">No chores yet. Add one below to start the chart.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  <th className="bg-[#c0c0c0] px-1 py-0.5 text-left font-bold">Chore</th>
                  {week.map((day, index) => (
                    <th
                      key={weekKeys[index]}
                      className={`px-1 py-0.5 text-center font-bold ${weekKeys[index] === todayKey ? "bg-[#000080] text-white" : "bg-[#c0c0c0]"}`}
                    >
                      {WEEKDAY_LABELS[index]}
                      <span className="block text-[10px] font-normal">{day.getDate()}</span>
                    </th>
                  ))}
                  <th className="bg-[#c0c0c0]" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {chores.map((chore) => {
                  const scheduledThisWeek = week.filter((day) => chore.days.includes(day.getDay())).length;
                  const doneThisWeek = weekKeys.filter((key) => chore.done.includes(key)).length;
                  return (
                    <tr key={chore.id}>
                      <th className="bg-white px-1 py-0.5 text-left font-normal">
                        <span className="font-bold">{chore.name}</span>
                        <span className="block text-[10px] text-[#404040]">{doneThisWeek}/{scheduledThisWeek} this week</span>
                      </th>
                      {week.map((day, index) => {
                        const key = weekKeys[index]!;
                        const scheduled = chore.days.includes(day.getDay());
                        const done = chore.done.includes(key);
                        return (
                          <td key={key} className="bg-white px-0.5 py-0.5 text-center">
                            {scheduled ? (
                              <button
                                type="button"
                                aria-pressed={done}
                                aria-label={`${done ? "Uncheck" : "Check off"} ${chore.name} for ${WEEKDAY_LABELS[index]} ${day.getDate()}`}
                                disabled={busyKey === `${chore.id}:${key}`}
                                onClick={() => void toggle(chore, key)}
                                className="h-[32px] w-[32px] cursor-pointer border border-[#808080] bg-[#dfdfdf] text-[14px] leading-none text-[#008000] sm:h-[28px] sm:w-[28px]"
                              >
                                {done ? "✓" : ""}
                              </button>
                            ) : (
                              <span className="text-[#808080]" aria-hidden="true">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="bg-white px-1 py-0.5 text-center">
                        <Button95 onClick={() => void remove(chore)} disabled={busyKey === chore.id} aria-label={`Delete chore ${chore.name}`}>
                          ✕
                        </Button95>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={save} className="mt-2 flex flex-col gap-2 border-t border-[#808080] pt-2 text-[12px] text-[#0a0a0a]">
          <p className="font-bold">Add a chore</p>
          <label htmlFor="chore-name" className="sr-only">Chore name</label>
          <input
            id="chore-name"
            type="text"
            maxLength={CHORE_NAME_MAX}
            value={name}
            onChange={(change) => setName(change.target.value)}
            placeholder="e.g. Water plants"
            className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
          />
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
            <legend className="sr-only">Days this chore is for</legend>
            {WEEKDAY_LABELS.map((label, day) => (
              <label key={label} className="flex items-center gap-1">
                <input type="checkbox" checked={days.includes(day)} onChange={() => flipDay(day)} />
                {label}
              </label>
            ))}
          </fieldset>
          <div>
            <Button95 type="submit" disabled={saving || !name.trim() || days.length === 0}>
              {saving ? "Encrypting…" : "🔒 Save chore"}
            </Button95>
          </div>
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
        </form>
        <p className="mt-2 text-[12px]">
          <Link to="/tools" className="text-[#0000cc] underline">Back to tools</Link>
        </p>
      </Window>
    </div>
  );
}
