import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { AppError, JOURNAL_ENTRY_MAX, timeAgo, type JournalEntry } from "@veil/core";
import { addJournalEntry, listJournal } from "@veil/features";
import type { Route } from "./+types/journal";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Journal — Everybody is Cool" }];
}

export default function Journal() {
  const vault = useSessionStore((state) => state.vault);
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!vault) return;
    try {
      setEntries(await listJournal(vault));
    } catch {
      setError("The journal could not be read.");
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!vault || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addJournalEntry(vault, text, { newId: newItemId, now: new Date() });
      setText("");
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The entry could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function saveOnShortcut(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
  }

  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      <Window title="New entry">
        <form onSubmit={save} className="flex flex-col gap-2 text-[12px] text-[#0a0a0a]">
          <label htmlFor="journal-text" className="font-bold">What is on your mind?</label>
          <textarea
            id="journal-text"
            autoFocus
            rows={5}
            maxLength={JOURNAL_ENTRY_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={saveOnShortcut}
            className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="flex items-center gap-2">
            <Button95 type="submit" disabled={saving || !text.trim()}>{saving ? "Encrypting…" : "🔒 Save entry"}</Button95>
            <span className="text-[11px] text-[#404040]">Ctrl/⌘+Enter also saves. Entries stay in this vault and are never put in a share file.</span>
          </div>
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
        </form>
      </Window>

      <Window title={`Entries${entries ? ` (${entries.length})` : ""}`}>
        {entries === null ? (
          <p className="text-[12px]">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-[12px]">No entries yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]">
            {entries.map((entry) => (
              <li key={entry.id} className="bg-white px-1.5 py-1">
                <p className="whitespace-pre-wrap">{entry.text}</p>
                <p className="mt-0.5 text-[11px] text-[#404040]">{timeAgo(entry.createdAt, now)} ago</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px]">
          <Link to="/tools" className="text-[#0000cc] underline">Back to tools</Link>
        </p>
      </Window>
    </div>
  );
}
