import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { wallpapers } from "@veil/tokens";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { downloadBackup, deleteRemoteBackup, generateRecoveryCode, isRecoveryCode, syncAvailable, uploadBackup } from "~/platform/backup-sync";
import { loadBookmark, forgetBookmark, formatTime } from "~/platform/cassette-bookmark";
import { ERASE_CONFIRMATION, clearPreferences, eraseVault, forgetRememberedAccess } from "~/platform/cookie-jar-actions";
import { PRESETS, purposeEnabled, useCookieJarStore, type Audience, type DeviceMemory, type PresetId } from "~/platform/cookie-jar-store";
import { downloadTextFile } from "~/platform/download";
import { forgetDesk, loadDesk, saveDesk, toggleTray, type Desk } from "~/platform/desk-memory";
import { PURPOSES, type Purpose, type PurposeGroup } from "~/platform/purpose-registry";
import { clearSession } from "~/platform/session-persist";
import { useSessionStore } from "~/platform/session";
import { MAX_MESSAGE, acceptPostcard, buildPostcard, deleteKept, loadKept, parsePostcard, sendAllowed, type Postcard } from "~/platform/room-postcard";
import { fortuneFor } from "~/platform/sticker-fortune";
import { vaultExport, vaultImport } from "~/platform/vault-service";

export function meta() {
  return [{ title: "Cookie Jar & Privacy - Everybody is Cool" }];
}

const GROUP_LABEL: Record<PurposeGroup, string> = {
  necessary: "Needed for the app to work",
  look: "Remember my look",
  "private-device": "Remember this private device",
  connected: "Connected play",
  diagnostics: "Optional diagnostics",
  external: "External services",
};
const GROUP_ORDER: PurposeGroup[] = ["necessary", "private-device", "look", "connected", "external"];
const TOGGLEABLE = ["desk-memory", "cassette-bookmark", "received-postcards", "backup-sync"];

/** Which registry keys exist in this browser right now - the "privacy mirror" (feature 9). */
function presentKeys(): Set<string> {
  const found = new Set<string>();
  try {
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key) found.add(key);
      }
    }
  } catch {
    // Storage blocked: the mirror shows nothing present rather than guessing.
  }
  return found;
}

const isPresent = (purpose: Purpose, keys: Set<string>) =>
  purpose.storage.some((ref) => (ref.key.endsWith("*") ? [...keys].some((k) => k.startsWith(ref.key.slice(0, -1))) : keys.has(ref.key)));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="mb-2 flex flex-col gap-1 bg-white px-1.5 py-1 text-[12px]"><legend className="font-bold">{title}</legend>{children}</fieldset>;
}

export default function CookieJar() {
  const { choices, loaded, persisted, load, choosePreset, setDeviceMemory, setAudience, setPurpose, resetChoices } = useCookieJarStore();
  const vault = useSessionStore((s) => s.vault);
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [desk, setDesk] = useState<Desk>({ tray: [], lastTool: null });
  const [kept, setKept] = useState<Postcard[]>([]);
  const refresh = () => setKeys(presentKeys());

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (loaded) { refresh(); setDesk(loadDesk(choices)); setKept(loadKept(choices)); } }, [loaded, choices]);

  const fortune = useMemo(() => fortuneFor(new Date()), []);
  const bookmark = loaded ? loadBookmark(choices) : null;
  const syncOn = syncAvailable();

  async function run(label: string, work: () => Promise<string | void>) {
    try {
      const done = await work();
      setNotice(done ?? `${label} done.`);
    } catch {
      setNotice(`${label} did not finish. Nothing was changed that you did not ask for.`);
    }
    refresh();
  }

  return (
    <main className="w95-desktop min-h-screen p-2">
      <Window title="Cookie Jar & Privacy">
        <div className="flex flex-col gap-1 text-[12px]">
          <Link to="/" className="underline">Home</Link>
          <p>Most of EIC lives in this browser, not in cookies. This page lists everything this device remembers, what could leave it, and lets you change your mind. Nothing here turns on tracking: EIC has no analytics to turn on.</p>
          <p className="text-[var(--w95-muted)]">Not anonymity: the host still sees page loads, and the relay join screen loads Cloudflare Turnstile. Someone using your unlocked browser can see an unlocked app.</p>
          {persisted === "memory" && <p role="alert" className="text-[#800000]">This browser blocked storage, so your choices apply to this visit only and will not be remembered.</p>}
          {notice && <p role="status" className="bg-[#ffffe1] px-1">{notice}</p>}

          <Section title="Presets (they only move the three controls below)">
            {(Object.keys(PRESETS) as PresetId[]).map((id) => (
              <label key={id} className="flex items-start gap-1">
                <input type="radio" name="preset" aria-label={PRESETS[id].label} checked={choices.preset === id} onChange={() => choosePreset(id)} />
                <span><span className="font-bold">{PRESETS[id].label}</span><span className="text-[var(--w95-muted)]"> - {PRESETS[id].blurb}</span></span>
              </label>
            ))}
            <p className="text-[11px] text-[var(--w95-muted)]">Every preset keeps working local features. Switching a preset never publishes, deletes your vault, wipes drafts or lengthens your session.</p>
          </Section>

          <Section title="The three controls">
            <label className="flex items-center gap-1">Device memory
              <select aria-label="Device memory" value={choices.deviceMemory} onChange={(e) => setDeviceMemory(e.target.value as DeviceMemory)}>
                <option value="temporary">Temporary desk (this tab only)</option>
                <option value="preferences">Remember harmless preferences</option>
              </select>
            </label>
            <label className="flex items-center gap-1">Audience
              <select aria-label="Audience" value={choices.audience} onChange={(e) => setAudience(e.target.value as Audience)}>
                <option value="just-me">Just me</option>
                <option value="friends">Chosen friends</option>
                <option value="published-per-item">Publish on purpose, one item at a time</option>
              </select>
            </label>
            <p>Measurement: <b>Off</b>. There is no diagnostics option because EIC does not collect any.</p>
            <p className="text-[11px] text-[var(--w95-muted)]">Remembering this private device is a separate, existing choice made when you unlock (8 hours by default, up to 30 days). Presets never select it.</p>
          </Section>

          <Section title="This device remembers (privacy mirror)">
            {GROUP_ORDER.map((group) => {
              const rows = PURPOSES.filter((p) => p.group === group);
              if (rows.length === 0) return null;
              return (
                <div key={group} className="mb-1">
                  <div className="font-bold">{GROUP_LABEL[group]}</div>
                  <ul className="flex flex-col gap-1">
                    {rows.map((row) => {
                      const toggle = TOGGLEABLE.includes(row.id) && (row.id !== "backup-sync" || syncOn);
                      return (
                        <li key={row.id} className="border-b border-[var(--w95-shade)] pb-1">
                          <label className="flex items-start gap-1">
                            {toggle ? <input type="checkbox" aria-label={row.label} checked={purposeEnabled(choices, row.id, row.defaultOn)} onChange={(e) => setPurpose(row.id, e.target.checked)} /> : <span aria-hidden="true">&bull;</span>}
                            <span>
                              <span className="font-bold">{row.label}</span>
                              <span className="text-[var(--w95-muted)]"> - {row.description}</span>
                              <span className="block text-[11px]">
                                Where: {row.storage.length ? row.storage.map((s) => `${s.kind} ${s.key}`).join(", ") : "not stored by EIC"}.{" "}
                                {row.leavesDevice ? `Leaves this device: yes, to ${row.leavesDevice.to} (${row.leavesDevice.what}).` : "Leaves this device: no."}{" "}
                                Expires: {row.expiry} {isPresent(row, keys) ? "Present now." : "Not present now."}{row.sensitive ? " Sensitive." : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {!syncOn && <p className="text-[11px] text-[var(--w95-muted)]">Encrypted backup sync is not switched on for this site, so its switch is hidden.</p>}
          </Section>

          <Section title="Private-side fun">
            <p><b>Sticker fortune for {fortune.day}:</b> <img className="inline align-middle" src={`/stickers/eic-sticker-${fortune.avatarId}.png`} alt={fortune.avatarLabel} width={32} height={32} /> {fortune.avatarLabel}. {fortune.prompt} <span className="text-[11px] text-[var(--w95-muted)]">(Worked out from today's date on this device. Nothing is stored.)</span></p>
            <div>
              <div className="font-bold">Desk memory: sticker tray {purposeEnabled(choices, "desk-memory") ? "" : "(switch Desk memory on above to keep it)"}</div>
              <div className="flex flex-wrap gap-1">
                {PROFILE_AVATARS.map((a) => (
                  <button key={a.id} type="button" aria-pressed={desk.tray.includes(a.id)} className={`min-h-[44px] min-w-[44px] border p-0.5 ${desk.tray.includes(a.id) ? "border-black bg-[#ffffe1]" : "border-[var(--w95-shade)]"}`}
                    onClick={() => { const next = toggleTray(desk, a.id); setDesk(next); const res = saveDesk(choices, next); if (res.level === "none") setNotice("Switch Desk memory on first, then your tray is kept."); else if (res.level === "memory") setNotice("Storage is blocked, so the tray is kept for this visit only."); refresh(); }}>
                    <img src={`/stickers/eic-sticker-${a.id}.png`} alt={a.label} width={32} height={32} />
                  </button>
                ))}
              </div>
            </div>
            <p><b>Cassette bookmark:</b> {bookmark ? `saved at ${formatTime(bookmark.seconds)}. After you pick your music folder, EIC lines the track up but never starts sound on its own.` : "nothing saved."} <span className="text-[11px] text-[var(--w95-muted)]">Stores a hash of the file path and a time, never a name.</span></p>
          </Section>

          <PostcardSection kept={kept} setKept={setKept} setNotice={setNotice} refresh={refresh} />

          {syncOn && <SyncSection vaultReady={Boolean(vault)} setNotice={setNotice} run={run} />}

          <Section title="Actions (each one says exactly what it touches)">
            <div className="flex flex-col gap-1">
              <div><Button95 onClick={() => { const r = clearPreferences(window.localStorage, window.sessionStorage); setDesk({ tray: [], lastTool: null }); setKept([]); setNotice(`Cleared ${r.removed.length} preference item(s). Your vault, remembered access and lock were not touched.`); refresh(); }}>Clear preferences</Button95> <span className="text-[11px]">Look, desk, bookmark, postcards, map layout. Never your vault or login.</span></div>
              <div><Button95 onClick={() => void run("Forget remembered access", async () => { await forgetRememberedAccess(() => clearSession()); return "Remembered access forgotten. You will need your passphrase next time. Your vault content was not touched."; })}>Forget remembered access</Button95> <span className="text-[11px]">Drops the saved unlock key only.</span></div>
              <div><Link className="underline" to="/feed">Review shared links</Link> <span className="text-[11px]">Each post shows its own link state and a revoke button. Revoking stops future opens; it cannot delete copies people already have.</span></div>
              <div><Button95 disabled={!vault} onClick={() => void run("Export", async () => { downloadTextFile("eic-vault-backup.json", await vaultExport()); return "Encrypted backup downloaded. It still needs your passphrase to open."; })}>Export encrypted backup</Button95> <span className="text-[11px]">Reads your vault; writes nothing here.{vault ? "" : " Unlock first."}</span></div>
              <div><Button95 onClick={() => { resetChoices(); setNotice("Your Cookie Jar choices were reset to the defaults. Nothing else changed."); }}>Reset these choices</Button95></div>
              <div className="border border-[#800000] p-1">
                <div className="font-bold text-[#800000]">Erase vault</div>
                <p>Permanently deletes your encrypted vault on this device. Without an exported backup there is no way to get it back. Export first.</p>
                <label>Type {ERASE_CONFIRMATION} to enable: <input aria-label="Type ERASE to enable" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>{" "}
                <Button95 disabled={typed.trim() !== ERASE_CONFIRMATION || !vault} onClick={() => void run("Erase", async () => { const outcome = await eraseVault({ typed, wipe: vault ? () => vault.wipe() : null, clearSession: () => clearSession() }); setTyped(""); return outcome === "erased" ? "Vault erased." : "Nothing was erased."; })}>Erase vault</Button95>
              </div>
            </div>
          </Section>
          <p className="text-[11px] text-[var(--w95-muted)]">A recipient can keep or screenshot anything you send. Turning something off stops future use here; it cannot take back what was already shared.</p>
        </div>
      </Window>
    </main>
  );
}

function PostcardSection({ kept, setKept, setNotice, refresh }: { kept: Postcard[]; setKept: (c: Postcard[]) => void; setNotice: (s: string) => void; refresh: () => void }) {
  const { choices } = useCookieJarStore();
  const [wallpaper, setWallpaper] = useState<string>(wallpapers[0].id);
  const [avatarId, setAvatarId] = useState<string>(PROFILE_AVATARS[0].id);
  const [message, setMessage] = useState("");
  const [incoming, setIncoming] = useState("");
  const [opened, setOpened] = useState<Postcard | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const built = useMemo(() => buildPostcard({ wallpaper, avatarId, message }), [wallpaper, avatarId, message]);
  const gate = sendAllowed(choices.audience);

  return (
    <Section title="Room postcard (a file you hand over yourself - EIC uploads nothing)">
      <div className="flex flex-wrap gap-1">
        <label>Wallpaper <select aria-label="Wallpaper" value={wallpaper} onChange={(e) => setWallpaper(e.target.value)}>{wallpapers.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select></label>
        <label>Sticker <select aria-label="Sticker" value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>{PROFILE_AVATARS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
      </div>
      <label>Message ({message.length}/{MAX_MESSAGE}) <input className="w-full" aria-label="Message" maxLength={MAX_MESSAGE} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      {"error" in built ? <p className="text-[11px]">{built.error}</p> : (
        <div>
          <p className="font-bold">Exactly what will leave this device ({built.bytes} bytes):</p>
          <pre className="overflow-x-auto bg-[#f0f0f0] p-1 text-[11px]" aria-label="Postcard payload">{built.payload}</pre>
          <p className="text-[11px]">Never included: {built.excluded.join(", ")}.</p>
          <p className="text-[11px]">{gate.reason}</p>
          <Button95 disabled={!gate.ok} onClick={() => { downloadTextFile("eic-room-postcard.json", built.payload); setNotice("Postcard saved as a file. Send it to your friend yourself."); }}>Save postcard file</Button95>{" "}
          <Button95 disabled={!gate.ok} onClick={() => { void navigator.clipboard?.writeText(built.payload).then(() => setNotice("Postcard copied."), () => setNotice("Copy was blocked. Use Save postcard file.")); }}>Copy postcard</Button95>
        </div>
      )}
      <div className="mt-1 border-t border-[var(--w95-shade)] pt-1">
        <div className="font-bold">Got a postcard?</div>
        <label>Paste it here <textarea className="w-full" aria-label="Paste it here" rows={2} value={incoming} onChange={(e) => { setIncoming(e.target.value); setOpened(null); setOpenError(null); }} /></label>
        <Button95 onClick={() => { const parsed = parsePostcard(incoming); if ("error" in parsed) { setOpened(null); setOpenError(parsed.error); } else { setOpenError(null); setOpened(parsed); } }}>Open it</Button95>
        {openError && <p role="alert" className="text-[#800000]">{openError}</p>}
        {opened && (
          <div className="mt-1 border border-[var(--w95-shade)] p-1">
            <p><img className="inline align-middle" src={`/stickers/eic-sticker-${opened.avatarId}.png`} alt="" width={32} height={32} /> <i>{opened.message}</i> <span className="text-[11px]">(wallpaper: {opened.wallpaper}). It is from someone else and unverified. Nothing is saved yet.</span></p>
            <Button95 onClick={() => { const r = acceptPostcard(choices, opened); setKept(r.kept); setNotice(r.write.level === "none" ? "Switch on Postcards you accepted above to keep it." : r.write.level === "memory" ? "Storage is blocked, so this postcard is kept for this visit only." : "Postcard kept on this device."); setOpened(null); setIncoming(""); refresh(); }}>Accept and keep</Button95>{" "}
            <Button95 onClick={() => { setOpened(null); setIncoming(""); setNotice("Declined. Nothing was stored."); }}>Decline</Button95>
          </div>
        )}
        {kept.length > 0 && (
          <ul className="mt-1">{kept.map((card, index) => (
            <li key={`${index}-${card.message}`}><i>{card.message}</i> <button type="button" className="underline" onClick={() => { setKept(deleteKept(choices, index)); refresh(); }}>Delete</button></li>
          ))}</ul>
        )}
      </div>
    </Section>
  );
}

function SyncSection({ vaultReady, setNotice, run }: { vaultReady: boolean; setNotice: (s: string) => void; run: (label: string, work: () => Promise<string | void>) => Promise<void> }) {
  const { choices } = useCookieJarStore();
  const enabled = purposeEnabled(choices, "backup-sync");
  const [code, setCode] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const usable = isRecoveryCode(code.trim());
  return (
    <Section title="Encrypted backup sync (optional, off until you switch it on above)">
      <p>Uploads your already-encrypted vault backup so you can recover on another device. The host holds ciphertext only and keeps it 30 days. You hold the recovery code; EIC never stores it.</p>
      {!enabled && <p className="text-[11px]">Switch on "Encrypted backup sync" in the list above to use this.</p>}
      <Button95 disabled={!enabled} onClick={() => { const next = generateRecoveryCode(); setFresh(next); setCode(next); }}>Make a new recovery code</Button95>
      {fresh && <p role="alert" className="bg-[#ffffe1] p-1">Write this down now. It is shown once and not saved: <code>{fresh}</code></p>}
      <label>Recovery code <input className="w-full" aria-label="Recovery code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <div className="flex flex-wrap gap-1">
        <Button95 disabled={!enabled || !usable || !vaultReady} onClick={() => void run("Upload", async () => { const out = await uploadBackup(code.trim(), await vaultExport()); return out.ok ? `Backup uploaded. It expires ${out.detail ?? "in 30 days"} unless you upload again.` : out.message; })}>Upload backup</Button95>
        <Button95 disabled={!enabled || !usable} onClick={() => void run("Restore", async () => { const got = await downloadBackup(code.trim()); if (!got.ok) return got.message; const result = await vaultImport(got.text); return `Restored ${result.records} record(s). Unlock with your passphrase.`; })}>Restore backup</Button95>
        <Button95 disabled={!enabled || !usable} onClick={() => void run("Delete", async () => { const out = await deleteRemoteBackup(code.trim()); return out.ok ? "Hosted backup deleted." : out.message; })}>Delete hosted backup</Button95>
      </div>
      {!vaultReady && <p className="text-[11px]">Unlock your vault to upload. Restoring replaces the vault on this device, so export a backup first.</p>}
    </Section>
  );
}
