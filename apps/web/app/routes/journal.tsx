import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { AppError, JOURNAL_ENTRY_MAX, timeAgo, type JournalEntry } from "@veil/core";
import { addJournalEntry, applyJournalFilters, buildJournalShareBundle, buildJournalShareLink, deleteJournalEntry, emptyJournalFilter, isJournalFilterActive, JOURNAL_DATE_RANGES, listJournal, loadSettings, updateJournalEntry, type JournalDateRange } from "@veil/features";
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
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<JournalDateRange>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<{ id: string; note: string } | null>(null);

  // Sharing one entry is always the owner's explicit per-entry choice. The entry travels inside
  // the link fragment; the recipient opens the app and sees it, no server involved.
  async function shareEntry(entry: JournalEntry) {
    if (!vault) return;
    setShareNote(null);
    try {
      const settings = await loadSettings(vault);
      if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle before sharing.");
      const bundle = buildJournalShareBundle({
        authorId: settings.authorId,
        authorHandle: settings.handle,
        text: entry.text,
        createdAt: entry.createdAt,
        now: new Date(),
      });
      const link = buildJournalShareLink(bundle, `${window.location.origin}/`);
      await navigator.clipboard.writeText(link);
      setShareNote({ id: entry.id, note: "Link copied. It opens the app and shows this entry - it travels in the link itself, no server involved." });
    } catch (caught) {
      setShareNote({ id: entry.id, note: caught instanceof AppError ? caught.message : "That entry could not be shared. Please try again." });
    }
  }

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

  function startEdit(entry: JournalEntry) {
    setEditingId(entry.id);
    setEditDraft(entry.text);
    setConfirmingId(null);
  }

  async function saveEdit(entry: JournalEntry) {
    if (!vault || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateJournalEntry(vault, entry.id, editDraft);
      setEditingId(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The entry could not be updated. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: JournalEntry) {
    if (!vault || saving) return;
    setSaving(true);
    setError(null);
    try {
      await deleteJournalEntry(vault, entry.id);
      setConfirmingId(null);
      if (editingId === entry.id) setEditingId(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "The entry could not be deleted. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const now = new Date();
  const filter = { query, range };
  const filterActive = isJournalFilterActive(filter);
  const filtered = entries === null ? null : applyJournalFilters(entries, filter, now);
  const shown = filtered === null ? null : filtered.entries;
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
          <div className="flex flex-wrap items-center gap-2">
            <Button95 type="submit" className="shrink-0 whitespace-nowrap" disabled={saving || !text.trim()}>{saving ? "Encrypting…" : "🔒 Save entry"}</Button95>
            <span className="text-[11px] text-[#404040]">Ctrl/⌘+Enter also saves. Entries stay in this vault: share files never include them. An entry leaves only when you tap its Share link, one entry at a time.</span>
          </div>
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
        </form>
      </Window>

      <Window title={`Entries${entries ? ` (${entries.length})` : ""}`}>
        {entries !== null && entries.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search entries"
              aria-label="Search entries"
              className="w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none sm:w-[260px]"
            />
            <div className="flex flex-wrap items-center gap-1">
              {JOURNAL_DATE_RANGES.map((option) => (
                <Button95 key={option.id} pressed={range === option.id} onClick={() => setRange(option.id)}>
                  {option.label}
                </Button95>
              ))}
              {filterActive && (
                <Button95
                  onClick={() => {
                    setQuery("");
                    setRange(emptyJournalFilter.range);
                  }}
                >
                  Clear filter
                </Button95>
              )}
            </div>
            {filterActive && filtered !== null && (
              <p className="text-[11px] text-[#404040]">
                Showing {filtered.entries.length} of {filtered.total} {filtered.total === 1 ? "entry" : "entries"}.
              </p>
            )}
          </div>
        )}
        {shown === null ? (
          <p className="text-[12px]">Loading…</p>
        ) : entries!.length === 0 ? (
          <p className="text-[12px]">No entries yet.</p>
        ) : shown.length === 0 ? (
          <p className="text-[12px]">
            {query.trim() !== "" && range !== "all"
              ? "No entries match that search in that date range."
              : query.trim() !== ""
                ? "No entries match that search."
                : "No entries in that date range."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]">
            {shown.map((entry) => (
              <li key={entry.id} className="bg-white px-1.5 py-1">
                {editingId === entry.id ? (
                  <div className="flex flex-col gap-1">
                    <textarea
                      rows={4}
                      maxLength={JOURNAL_ENTRY_MAX}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      aria-label="Edit entry"
                      className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
                    />
                    <div className="flex gap-1">
                      <Button95 onClick={() => void saveEdit(entry)} disabled={saving || !editDraft.trim()}>Save</Button95>
                      <Button95 onClick={() => setEditingId(null)} disabled={saving}>Cancel</Button95>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap">{entry.text}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#404040]">
                      <span>{timeAgo(entry.createdAt, now)} ago</span>
                      <button type="button" onClick={() => startEdit(entry)} className="text-[#0000cc] underline">
                        Edit
                      </button>
                      <button type="button" onClick={() => void shareEntry(entry)} className="text-[#0000cc] underline">
                        Share
                      </button>
                      {confirmingId === entry.id ? (
                        <>
                          <span>Delete this entry?</span>
                          <button type="button" onClick={() => void remove(entry)} className="font-bold text-[#800000] underline">
                            Yes, delete
                          </button>
                          <button type="button" onClick={() => setConfirmingId(null)} className="text-[#0000cc] underline">
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirmingId(entry.id)} className="text-[#800000] underline">
                          Delete
                        </button>
                      )}
                    </div>
                    {shareNote?.id === entry.id && (
                      <p className="mt-0.5 text-[11px] text-[#404040]">{shareNote.note}</p>
                    )}
                  </>
                )}
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
