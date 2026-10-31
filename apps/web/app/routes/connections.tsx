import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { AppError, HANDLE_MAX, timeAgo, type Connection } from "@veil/core";
import {
  MAX_SHARE_FILE_BYTES,
  buildShareBundle,
  ensureAuthorId,
  importShareBundle,
  removeConnection,
  setConnectionHidden,
  setConnectionNickname,
  unreadCounts,
} from "@veil/features";
import type { Route } from "./+types/connections";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { downloadTextFile } from "~/platform/download";
import { useSessionStore } from "~/platform/session";
import { useSocial } from "~/platform/use-social";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Connections — Everybody is Cool" }];
}

const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";


// Pure presentational half, exported for render tests: connection rows with chat links + unread badges.
export function ConnectionsList({
  connections,
  unread,
  now,
}: {
  connections: Connection[];
  unread: Record<string, number>;
  now: Date;
}) {
  if (connections.length === 0) {
    return <p className="text-[12px]">No connections yet. Import a friend's share file to add one.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-[12px]">
      {connections.map((connection) => {
        const count = unread[connection.id] ?? 0;
        return (
          <li key={connection.id} className="flex items-center justify-between bg-white px-1.5 py-1">
            <span className="font-bold">@{connection.handle}</span>
            <span className="flex items-center gap-2">
              {count > 0 && (
                <span className="bg-[#000080] px-1 font-bold text-white" aria-label={`${count} unread message${count === 1 ? "" : "s"}`}>
                  {count} new
                </span>
              )}
              <Link to={`/chat/${connection.id}`} className="underline">
                Chat
              </Link>
              <span className="text-[#404040]">connected {timeAgo(connection.addedAt, now)} ago</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Connections() {
  const vault = useSessionStore((state) => state.vault);
  const social = useSocial(vault);
  const { settings, items, connections } = social;
  const fileInput = useRef<HTMLInputElement>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [unread, setUnread] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    if (vault) {
      void unreadCounts(vault).then((counts) => {
        if (live) setUnread(counts);
      });
    }
    return () => {
      live = false;
    };
  }, [vault]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Synchronous guard: drop events and the import buttons can fire faster than setBusy renders.
  // Must stay above the early returns below - hooks may not be conditional (React error #310).
  const importing = useRef(false);

  if (items.status === "loading") return <p className="text-[12px]">Loading…</p>;
  if (items.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{items.message}</p>;

  const allItems = items.items;
  const shareable = allItems.filter((item) => item.authorId === null && item.visibility === "shareable").length;
  const handleValue = handle ?? settings.handle ?? "";

  async function run(action: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      return true;
    } catch (caught) {
      setError(caught instanceof AppError ? caught.message : "That did not work. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveHandle(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (!vault || !social.settingsReady) return "";
      const clean = handleValue.trim();
      if (!clean) throw new AppError("Enter a handle.");
      const withId = await ensureAuthorId(vault, settings, newItemId);
      await social.update({ ...withId, handle: clean.slice(0, HANDLE_MAX) });
      setHandle(null);
      return "Handle saved.";
    });
  }

  function exportFile() {
    void run(async () => {
      if (!vault || !social.settingsReady) return "";
      const { text, postCount } = await buildShareBundle(vault, settings, allItems, new Date());
      downloadTextFile(`eic-share-${new Date().toISOString().slice(0, 10)}.json`, text);
      return `Share file downloaded with ${postCount} post${postCount === 1 ? "" : "s"}. Anyone who gets it can read them.`;
    });
  }

  function importText(read: () => Promise<string>): Promise<boolean> {
    if (importing.current) return Promise.resolve(false);
    importing.current = true;
    return run(async () => {
      if (!vault || !social.settingsReady) return "";
      const result = await importShareBundle(vault, await read(), { settings, newId: newItemId, now: new Date() });
      social.refresh();
      const basis = result.verified ? `Verified signature from @${result.handle}` : `Unsigned file - trust the sender (@${result.handle})`;
      return `${basis}: ${result.added} new, ${result.updated} updated, ${result.likesReceived} new like${result.likesReceived === 1 ? "" : "s"} on your posts.`;
    }).finally(() => {
      importing.current = false;
    });
  }

  function importFile(file: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    importText(async () => {
      if (file.size > MAX_SHARE_FILE_BYTES) throw new AppError("That file is too large to import.");
      return file.text();
    });
  }

  function importPasted() {
    const text = pasted;
    // Cleared only once the import actually worked, so a failed import never eats the paste.
    void importText(async () => text).then((ok) => {
      if (ok) setPasted("");
    });
  }

  const postCountFor = (connectionId: string) => allItems.filter((item) => item.authorId === connectionId).length;
  const visible = connections.filter((connection) => !connection.hidden);
  const hiddenConns = connections.filter((connection) => connection.hidden);

  function saveNickname(connectionId: string) {
    void run(async () => {
      if (!vault) return "";
      await setConnectionNickname(vault, connectionId, nicknameDraft);
      social.refresh();
      setRenamingId(null);
      return nicknameDraft.trim() ? "Nickname saved." : "Nickname cleared.";
    });
  }

  function toggleHidden(connection: Connection) {
    void run(async () => {
      if (!vault) return "";
      await setConnectionHidden(vault, connection.id, !connection.hidden);
      social.refresh();
      return connection.hidden ? `@${connection.handle} is back in the list.` : `@${connection.handle} hidden. Their posts are still in your vault.`;
    });
  }

  function remove(connectionId: string, handle: string, dropPosts: boolean) {
    void run(async () => {
      if (!vault) return "";
      const result = await removeConnection(vault, connectionId, { dropPosts });
      social.refresh();
      setRemovingId(null);
      return dropPosts
        ? `@${handle} removed, along with ${result.droppedPosts} of their post${result.droppedPosts === 1 ? "" : "s"}.`
        : `@${handle} removed. Their posts are still in your vault.`;
    });
  }

  function connectionRow(connection: Connection) {
    const postCount = postCountFor(connection.id);
    const unreadCount = unread[connection.id] ?? 0;
    return (
      <li key={connection.id} className="flex flex-col gap-1 bg-white px-1.5 py-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-bold">
            {connection.nickname ? `${connection.nickname} (@${connection.handle})` : `@${connection.handle}`}
          </span>
          <span className="text-[#404040]">
            {postCount} post{postCount === 1 ? "" : "s"} · last import {timeAgo(connection.lastImportAt ?? connection.addedAt, new Date())} ago
          </span>
          {unreadCount > 0 && (
            <span className="bg-[#000080] px-1 font-bold text-white" aria-label={`${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`}>
              {unreadCount} new
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          <Link to={`/chat/${connection.id}`} className="underline">Chat</Link>
          <Button95 onClick={() => { setRenamingId(connection.id); setNicknameDraft(connection.nickname ?? ""); setRemovingId(null); }} disabled={busy}>Rename</Button95>
          <Button95 onClick={() => toggleHidden(connection)} disabled={busy}>{connection.hidden ? "Unhide" : "Hide"}</Button95>
          <Button95 onClick={() => { setRemovingId(connection.id); setRenamingId(null); }} disabled={busy}>Remove…</Button95>
        </div>
        {renamingId === connection.id && (
          <div className="flex gap-1">
            <input className={inputClass} value={nicknameDraft} maxLength={HANDLE_MAX} onChange={(e) => setNicknameDraft(e.target.value)} placeholder="Nickname (only you see it)" aria-label="Nickname" />
            <Button95 onClick={() => saveNickname(connection.id)} disabled={busy}>Save</Button95>
            <Button95 onClick={() => setRenamingId(null)} disabled={busy}>Cancel</Button95>
          </div>
        )}
        {removingId === connection.id && (
          <div className="flex flex-col gap-1 bg-[#ffffe1] px-1.5 py-1">
            <span>Remove @{connection.handle}? You can keep their posts in your vault or drop them entirely.</span>
            <div className="flex flex-wrap gap-1">
              <Button95 onClick={() => remove(connection.id, connection.handle, false)} disabled={busy}>Remove, keep posts</Button95>
              <Button95 onClick={() => remove(connection.id, connection.handle, true)} disabled={busy}>Remove + drop posts</Button95>
              <Button95 onClick={() => setRemovingId(null)} disabled={busy}>Cancel</Button95>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Window title="Your handle">
        <form onSubmit={saveHandle} className="flex flex-col gap-2 text-[12px]">
          <p>Connections see this name next to your posts and likes. It is not tied to your passphrase.</p>
          <div className="flex gap-1">
            <input className={inputClass} value={handleValue} maxLength={HANDLE_MAX} onChange={(e) => setHandle(e.target.value)} aria-label="Handle" />
            <Button95 type="submit" disabled={busy || !social.settingsReady}>Save</Button95>
          </div>
        </form>
      </Window>

      <Window title="Share and connect">
        <div
          className="flex flex-col gap-2 text-[12px]"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            importFile(e.dataTransfer.files[0]);
          }}
        >
          <p>
            There is no server. Press Share on any post, or export a share file here, send it any way you like, and import what your friend sends back by file, drop, or paste.
            Importing adds their posts to your feed, lists them as a connection, and brings in any likes they gave you.
          </p>
          <p className="bg-[#ffffe1] px-1.5 py-1">
            A share file is <b>not encrypted</b>. It holds your shareable posts, their photos, your handle, and the posts you liked.
            Private posts, notes, and settings are never in an exported file - but pressing ↗ Share on one of your own posts sends just that post, even a private one.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button95 onClick={exportFile} disabled={busy || !social.settingsReady || !settings.handle}>Export share file ({Math.min(shareable, 100)} post{Math.min(shareable, 100) === 1 ? "" : "s"})</Button95>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => importFile(e.target.files?.[0])} aria-label="Choose a share file" />
            <Button95 onClick={() => fileInput.current?.click()} disabled={busy || !social.settingsReady || !settings.handle}>Import a share file…</Button95>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-bold">Or paste what a friend sent you</span>
            <textarea
              className={inputClass}
              rows={3}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste a shared post here, or drop a .json file anywhere in this box"
            />
          </label>
          <div>
            <Button95 onClick={importPasted} disabled={busy || !social.settingsReady || !settings.handle || !pasted.trim()}>Import pasted text</Button95>
          </div>
          {!settings.handle && <p className="text-[#404040]">Choose a handle first.</p>}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert" className="text-[#800000]">{error}</p>}
        </div>
      </Window>

      <Window title={`Connections (${visible.length})`}>
        {connections.length === 0 ? (
          <p className="text-[12px]">No connections yet. Import a friend's share file to add one.</p>
        ) : (
          <div className="flex flex-col gap-2 text-[12px]">
            <p>To refresh someone's posts, import their newest share file again - importing updates in place.</p>
            {visible.length > 0 && <ul className="flex flex-col gap-1">{visible.map(connectionRow)}</ul>}
            {hiddenConns.length > 0 && (
              <details>
                <summary>Hidden ({hiddenConns.length})</summary>
                <ul className="mt-1 flex flex-col gap-1">{hiddenConns.map(connectionRow)}</ul>
              </details>
            )}
          </div>
        )}
      </Window>
    </div>
  );
}

