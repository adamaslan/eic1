import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { AppError, JOURNAL_ENTRY_MAX, timeAgo, type JournalEntry } from "@veil/core";
import { addJournalEntry, applyJournalFilters, buildJournalShareBundle, buildJournalShareLink, deleteJournalEntry, emptyJournalFilter, isFeatureEnabled, isJournalFilterActive, JOURNAL_DATE_RANGES, listJournal, loadSettings, updateJournalEntry, type JournalDateRange } from "@veil/features";
import type { Route } from "./+types/journal";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { useFeatureEnabled } from "~/platform/use-gate";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Journal — Everybody is Cool" }];
}

export default function Journal() {
  const vault = useSessionStore((state) => state.vault);
  const editingEnabled = useFeatureEnabled(vault, "journal-editing");
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<JournalDateRange>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Per-entry share state. A blocked automatic copy keeps the built link in component state
  // ONLY (never storage) and offers explicit next steps; the text the link was built from is
  // remembered so a later edit marks the link stale instead of silently handing out old text.
  type ShareState =
    | { id: string; kind: "copied" }
    | { id: string; kind: "error"; note: string }
    | { id: string; kind: "fallback"; link: string; builtFrom: string; note: string | null };
  const [shareState, setShareState] = useState<ShareState | null>(null);

  // Sharing one entry is always the owner's explicit per-entry choice. The entry travels inside
  // the link fragment; the recipient opens the app and sees it, no server involved.
  async function buildEntryLink(entry: JournalEntry): Promise<string> {
    if (!vault) throw new AppError("Unlock your vault before sharing.");
    const settings = await loadSettings(vault);
    if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle before sharing.");
    const bundle = buildJournalShareBundle({
      authorId: settings.authorId,
      authorHandle: settings.handle,
      text: entry.text,
      createdAt: entry.createdAt,
      now: new Date(),
    });
    return buildJournalShareLink(bundle, `${window.location.origin}/`);
  }

  async function shareEntry(entry: JournalEntry) {
    if (!vault) return;
    setShareState(null);
    try {
      const link = await buildEntryLink(entry);
      try {
        await navigator.clipboard.writeText(link);
        setShareState({ id: entry.id, kind: "copied" });
      } catch {
        // The automatic copy was blocked. Nothing left the vault: the link stays in memory
        // only and the next step - share sheet, download, or nothing - is the owner's choice.
        setShareState({ id: entry.id, kind: "fallback", link, builtFrom: entry.text, note: null });
      }
    } catch (caught) {
      setShareState({ id: entry.id, kind: "error", note: caught instanceof AppError ? caught.message : "That entry could not be shared. Please try again." });
    }
  }

  // Hands the link out through one explicit choice. A stale link (entry edited since it was
  // built) is rebuilt from the current text first, so a choice never hands out old text.
  async function handOutShared(entry: JournalEntry, state: Extract<ShareState, { kind: "fallback" }>, via: "sheet" | "file") {
    let link = state.link;
    if (entry.text !== state.builtFrom) {
      try {
        link = await buildEntryLink(entry);
      } catch (caught) {
        setShareState({ id: entry.id, kind: "error", note: caught instanceof AppError ? caught.message : "That entry could not be shared. Please try again." });
        return;
      }
    }
    if (via === "sheet") {
      if (typeof navigator.share !== "function") {
        setShareState({ id: entry.id, kind: "fallback", link, builtFrom: entry.text, note: "This browser has no share sheet - download the file instead." });
        return;
      }
      try {
        await navigator.share({ title: "A journal entry", text: link });
        setShareState({ id: entry.id, kind: "fallback", link, builtFrom: entry.text, note: "Shared from the sheet." });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return; // canceled: nothing handed out, no state change
        setShareState({ id: entry.id, kind: "fallback", link, builtFrom: entry.text, note: "The share sheet did not complete. Nothing else was sent." });
      }
    } else {
      const blob = new Blob([link], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "shared-journal-entry.txt";
      document.body.append(anchor);
      anchor.click();
      // Let the browser consume the blob before cleanup, including on mobile Safari.
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 1000);
      setShareState({ id: entry.id, kind: "fallback", link, builtFrom: entry.text, note: "Download requested. The file holds the link as readable text." });
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
    setNotice(null);
    try {
      await addJournalEntry(vault, text, { newId: newItemId, now: new Date() });
      setText("");
      await reload();
      setNotice("Saved - encrypted in this vault.");
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
    setNotice(null);
    try {
      const settings = await loadSettings(vault);
      if (!isFeatureEnabled(settings, "journal-editing")) {
        setEditingId(null);
        setError("Journal editing is turned off in Tools. Your entry is unchanged.");
        return;
      }
      await updateJournalEntry(vault, entry.id, editDraft);
      setEditingId(null);
      await reload();
      setNotice("Changes saved - encrypted in this vault.");
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
    setNotice(null);
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
        <form onSubmit={save} className="flex flex-col gap-2 text-[12px] text-[var(--w95-ink)]">
          <label htmlFor="journal-text" className="font-bold">What is on your mind?</label>
          <textarea
            id="journal-text"
            autoFocus
            rows={5}
            maxLength={JOURNAL_ENTRY_MAX}
            value={text}
            disabled={saving}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={saveOnShortcut}
            className="w-full bg-white px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button95 type="submit" className="shrink-0 whitespace-nowrap" disabled={saving || !text.trim()}>{saving ? "Encrypting…" : "🔒 Save entry"}</Button95>
            <span className="text-[11px] text-[var(--w95-muted)]">Ctrl/⌘+Enter also saves. Entries stay encrypted in this vault. Post share files never include journal entries; they leave only when you export a copy or share an entry's link yourself.</span>
          </div>
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
          {notice && <p role="status">{notice}</p>}
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
              className="w-full bg-white px-1.5 py-1 text-[12px] text-[var(--w95-ink)] outline-none sm:w-[260px]"
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
              <p className="text-[11px] text-[var(--w95-muted)]">
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
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--w95-muted)]">
                      <span>{timeAgo(entry.createdAt, now)} ago</span>
                      {editingEnabled && (
                        <button type="button" onClick={() => startEdit(entry)} className="text-[var(--w95-link)] underline">
                          Edit
                        </button>
                      )}
                      <button type="button" onClick={() => void shareEntry(entry)} className="text-[var(--w95-link)] underline">
                        Share
                      </button>
                      {confirmingId === entry.id ? (
                        <>
                          <span>Delete this entry?</span>
                          <button type="button" onClick={() => void remove(entry)} className="font-bold text-[#800000] underline">
                            Yes, delete
                          </button>
                          <button type="button" onClick={() => setConfirmingId(null)} className="text-[var(--w95-link)] underline">
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirmingId(entry.id)} className="text-[#800000] underline">
                          Delete
                        </button>
                      )}
                    </div>
                    {shareState?.id === entry.id && shareState.kind !== "fallback" && (
                      <p className="mt-0.5 text-[11px] text-[var(--w95-muted)]">
                        {shareState.kind === "copied"
                          ? "Link copied. It opens the app and shows this entry - it travels in the link itself, no server involved."
                          : shareState.note}
                      </p>
                    )}
                    {shareState?.id === entry.id && shareState.kind === "fallback" && (
                      <div className="mt-0.5 flex flex-col gap-1 text-[11px] text-[var(--w95-muted)]">
                        {entry.text === shareState.builtFrom ? (
                          <p>Your browser blocked the automatic copy - the link was not copied. Choose a next step, or do nothing.</p>
                        ) : (
                          <p>This link still holds the entry's older text - it does not include your latest edit. Your next share or download will rebuild it from the current text.</p>
                        )}
                        <p className="font-bold">Either choice hands out this entry as readable text - anyone who gets the link can read it.</p>
                        <div className="flex flex-wrap gap-1">
                          <Button95 onClick={() => void handOutShared(entry, shareState, "sheet")}>Open share sheet</Button95>
                          <Button95 onClick={() => void handOutShared(entry, shareState, "file")}>Download as file</Button95>
                        </div>
                        {shareState.note && <p role="status">{shareState.note}</p>}
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px]">
          <Link to="/tools" className="text-[var(--w95-link)] underline">Back to tools</Link>
        </p>
      </Window>
    </div>
  );
}
