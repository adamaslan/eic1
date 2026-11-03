import { useState } from "react";
import { Link } from "react-router";
import { FONT_CHOICES, WALLPAPERS, WINDOW_ACCENTS, reviewLatestFeedProfile, selectedProfile, saveProfileDraft, updateFeedProfile, type ProfileDraft, type Profile } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";
import { Button95 } from "~/ui95/Button95";
import { ProfileAssets } from "./profile-assets";
import { Window } from "~/ui95/Window";

const input = "w-full border border-[#808080] bg-white p-1 text-[12px] text-black";
const labels = { bio: "Bio", avatar: "Avatar", decorations: "Decorations", theme: "Background and theme", song: "Favorite song", book: "Favorite book" };
export function ProfileStudio({ initial, vault, handle, renderPreview, onSaved }: {
  initial: ProfileDraft; vault: UnlockedVault; handle: string;
  renderPreview: (profile: Profile) => React.ReactNode; onSaved: (draft: ProfileDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<Profile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const profile = draft.profile;
  let projected: Profile | null = null;
  let projectionError = "";
  try { projected = selectedProfile(draft, handle); } catch (e) { projectionError = e instanceof Error ? e.message : "Cannot prepare this profile."; }
  function field(next: Partial<Profile>) { setDraft({ ...draft, profile: { ...profile, ...next } }); setMessage(""); }
  async function act(shared: boolean) {
    setBusy(true); setError(""); setMessage("");
    try {
      if (shared) {
        const updated = await updateFeedProfile(vault, draft, new Date());
        setDraft({ ...draft, feedBaseline: updated });
        setLatest(undefined);
        setMessage("Feed profile updated locally. Nothing was uploaded. Exporting a feed later includes exactly the selected preview. Old copies cannot be recalled.");
      } else {
        await saveProfileDraft(vault, draft); setSaved(draft); onSaved(draft);
        setMessage("Private draft saved in this encrypted vault. Feed profile unchanged.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save. Please try again."); }
    finally { setBusy(false); }
  }
  return <Window title="Profile studio">
    <div className="flex flex-col gap-3 text-[12px]">
      <p>Your draft is private. The separate feed profile changes only when you press Update selected feed profile. A name and author identity are always included. Feed files are readable by anyone who gets them.</p>
      <div className="flex flex-wrap gap-2"><Button95 onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Customize profile"}</Button95><Link to="/" className="underline">Home</Link></div>
      {editing && <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
        <label>Display name (always in feed profile)<input className={input} maxLength={40} value={profile.displayName} onChange={e => field({ displayName: e.target.value })} /></label>
        <label>Bio ({profile.bio.length}/500)<textarea className={input} rows={3} maxLength={500} value={profile.bio} onChange={e => field({ bio: e.target.value })} /></label>
        <label>Favorite song<input className={input} maxLength={120} value={draft.song} onChange={e => setDraft({ ...draft, song: e.target.value })} /></label>
        <label>Favorite book<input className={input} maxLength={120} value={draft.book} onChange={e => setDraft({ ...draft, book: e.target.value })} /></label>
        <p>Titles and artists/authors only. No streaming, embeds or automatic requests.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <label>Background color<select className={input} value={profile.theme.wallpaper} onChange={e => field({ theme: { ...profile.theme, wallpaper: e.target.value as Profile["theme"]["wallpaper"] } })}>{WALLPAPERS.map(v => <option key={v} value={v}>{({ teal: "Teal", clouds: "Cadet blue", dither: "Charcoal", none: "Classic silver" })[v]}</option>)}</select></label>
          <label>Name accent<select className={input} value={profile.theme.windowAccent} onChange={e => field({ theme: { ...profile.theme, windowAccent: e.target.value as Profile["theme"]["windowAccent"] } })}>{WINDOW_ACCENTS.map(v => <option key={v}>{v}</option>)}</select></label>
          <label>Profile font<select className={input} value={profile.theme.fontChoice} onChange={e => field({ theme: { ...profile.theme, fontChoice: e.target.value as Profile["theme"]["fontChoice"] } })}>{FONT_CHOICES.map(v => <option key={v}>{v}</option>)}</select></label>
        </div>
        <ProfileAssets profile={profile} change={next => field(next)} />
        <fieldset className="flex flex-col gap-1 border border-[#808080] p-2"><legend>Include in feed profile</legend>
          {(Object.keys(labels) as Array<keyof typeof labels>).map(key => <label key={key} className="flex min-h-[36px] items-center gap-2"><input type="checkbox" checked={draft.selected[key]} onChange={e => setDraft({ ...draft, selected: { ...draft.selected, [key]: e.target.checked } })} />{labels[key]}</label>)}
        </fieldset>
        {projectionError && <p role="alert">{projectionError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button95 onClick={() => void act(false)}>Save private draft</Button95>
          <Button95 onClick={() => { setDraft(saved); setError(""); setMessage("Unsaved changes discarded. Feed profile unchanged."); }}>Discard unsaved changes</Button95>
          <Button95 pressed={preview} onClick={() => setPreview(!preview)}>Preview selected feed profile</Button95>
          <Button95 onClick={async () => {
            setBusy(true); setError("");
            try { const reviewed = await reviewLatestFeedProfile(vault, draft); setDraft(reviewed); setLatest(reviewed.feedBaseline); setMessage("Latest saved feed profile shown below. Your private fields are unchanged. Compare it with your selected preview before updating; update replaces it, not merges it."); }
            catch (e) { setError(e instanceof Error ? e.message : "Could not load the latest feed profile."); }
            finally { setBusy(false); }
          }}>Review latest saved feed profile</Button95>
          <Button95 disabled={!projected} onClick={() => void act(true)}>Update selected feed profile</Button95>
        </div>
      </fieldset>}
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      {latest !== undefined && <section aria-label="Latest saved feed profile"><p>Latest saved feed profile (not your private draft)</p>{latest ? renderPreview(latest) : <p>No saved feed profile yet.</p>}</section>}
      {editing && preview && projected && <section aria-label="Selected feed profile preview"><p>Exact selected content. Not uploaded.</p>{renderPreview(projected)}</section>}
    </div>
  </Window>;
}
