import { useRef, useState, type FormEvent } from "react";
import { AppError, HANDLE_MAX, timeAgo } from "@veil/core";
import { MAX_SHARE_FILE_BYTES, buildShareBundle, ensureAuthorId, importShareBundle } from "@veil/features";
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

  // Synchronous guard: drop events and the import buttons can fire faster than setBusy renders.
  const importing = useRef(false);

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

      <Window title={`Connections (${connections.length})`}>
        {connections.length === 0 ? (
          <p className="text-[12px]">No connections yet. Import a friend's share file to add one.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]">
            {connections.map((connection) => (
              <li key={connection.id} className="flex justify-between bg-white px-1.5 py-1">
                <span className="font-bold">@{connection.handle}</span>
                <span className="text-[#404040]">connected {timeAgo(connection.addedAt, new Date())} ago</span>
              </li>
            ))}
          </ul>
        )}
      </Window>
    </div>
  );
}
