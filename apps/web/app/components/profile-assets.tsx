import { useState, useRef, useEffect } from "react";
import { addProfileSticker, changeProfileSticker, PROFILE_STICKERS, PROFILE_AVATARS, PROFILE_AVATAR_MAX_BYTES, ProfileSchema, type Profile } from "@veil/features";
import { Button95 } from "~/ui95/Button95";

/** Local raster decode only, flattened to an embedded PNG. Nothing reaches an image host. */
async function avatarFromFile(file: File): Promise<Profile["avatar"]> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG or WebP image. SVG and animated files are not supported here.");
  if (file.size > 2 * 1024 * 1024) throw new Error("Choose an image under 2 MB before resizing.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 16_000_000 || bitmap.width > 8192 || bitmap.height > 8192) throw new Error("Choose an image under 16 megapixels and 8192 pixels per side.");
    const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("This browser could not resize the image.");
    // Fit, never crop. Transparent letterboxing preserves the whole picture.
    const ratio = Math.min(96 / bitmap.width, 96 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * ratio)); const height = Math.max(1, Math.round(bitmap.height * ratio));
    ctx.drawImage(bitmap, (96 - width) / 2, (96 - height) / 2, width, height);
    const data = canvas.toDataURL("image/png").split(",")[1];
    if ((Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)) > PROFILE_AVATAR_MAX_BYTES) throw new Error("The resized PNG is over 25 KB. Try a simpler image.");
    return { kind: "data-uri", mime: "image/png", data };
  } finally { bitmap.close(); }
}

export function ProfileAssets({ profile, change }: { profile: Profile; change: (profile: Profile) => void }) {
  const [selected, setSelected] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false); const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(profile); latest.current = profile;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = profile.decorations.find(d => d.id === selected);
  function edit(action: Parameters<typeof changeProfileSticker>[2]) {
    try { change(changeProfileSticker(profile, selected, action)); setError(""); if (action === "remove") setSelected(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change this decoration."); }
  }
  async function choose(file?: File) {
    if (!file) return; setBusy(true); setError("");
    try { const avatar = await avatarFromFile(file); if (live.current) change(ProfileSchema.parse({ ...latest.current, avatar })); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not read this image. Your avatar is unchanged."); }
    finally { if (live.current) setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  return <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2 border border-[#808080] p-2">
    <legend>Avatar and decorations</legend>
    <p>Local files only. Avatar fits inside 96 x 96 without cropping, stored as PNG (25 KB cap), shown at 64 x 64. Save private draft to keep these edits. Sharing still needs explicit field selection and feed-profile update.</p>
    <label>Choose avatar image<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="block max-w-full" onChange={e => void choose(e.target.files?.[0])} /></label>
    <p>Or choose an avatar drawn in Paint. Nothing is selected or shared automatically.</p>
    <div role="group" aria-label="Paint avatars" className="grid grid-cols-3 gap-2 sm:grid-cols-4">{PROFILE_AVATARS.map(avatar => <Button95 key={avatar.id} onClick={() => change(ProfileSchema.parse({ ...profile, avatar: { kind: "data-uri", mime: "image/png", data: avatar.data } }))}><span className="flex flex-col items-center"><img width={64} height={64} src={`data:image/png;base64,${avatar.data}`} alt="" /><span>{avatar.label}</span></span></Button95>)}</div>
    <Button95 disabled={!profile.avatar} onClick={() => change({ ...profile, avatar: null })}>Remove avatar</Button95>
    {profile.avatar && <p>{(Math.floor(profile.avatar.data.length * 3 / 4) - (profile.avatar.data.endsWith("==") ? 2 : profile.avatar.data.endsWith("=") ? 1 : 0)).toLocaleString()} encoded avatar bytes</p>}
    <p>{profile.decorations.length}/32 decorations. Small built-in SVGs, no downloads. Decorations are behind the profile window and may be covered by it.</p>
    <div className="flex flex-wrap gap-2">{PROFILE_STICKERS.map(kind => <Button95 key={kind} disabled={profile.decorations.length >= 32} onClick={() => {
      try { const id = `sticker-${crypto.randomUUID()}`; change(addProfileSticker(profile, kind, id)); setSelected(id); setError(""); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not add this sticker."); }
    }}>Add {kind}</Button95>)}</div>
    <label>Selected decoration<select className="block w-full bg-white p-1 text-black" value={current?.id ?? ""} onChange={e => setSelected(e.target.value)}><option value="">Choose a decoration</option>{profile.decorations.map((d, i) => <option key={d.id} value={d.id}>{i + 1}. {d.kind}</option>)}</select></label>
    {current && <div className="flex flex-col gap-2"><p>Position {Math.round(current.position.x * 100)}%, {Math.round(current.position.y * 100)}% · size {current.scale}x</p>
      <div role="group" aria-label="Move decoration" className="flex flex-wrap gap-1">{(["left", "right", "up", "down"] as const).map(action => <Button95 key={action} onClick={() => edit(action)}>Move {action}</Button95>)}</div>
      <div className="flex flex-wrap gap-1"><Button95 onClick={() => edit("grow")}>Larger</Button95><Button95 onClick={() => edit("shrink")}>Smaller</Button95><Button95 onClick={() => edit("front")}>Front of decorations</Button95><Button95 onClick={() => edit("back")}>Back of decorations</Button95><Button95 onClick={() => edit("remove")}>Remove selected decoration</Button95></div>
    </div>}
    <Button95 disabled={!profile.decorations.length} onClick={() => setConfirm(true)}>Remove all decorations...</Button95>
    {confirm && <div><p>Remove all decorations from this draft? Existing exported copies are unchanged.</p><Button95 onClick={() => { change({ ...profile, decorations: [] }); setSelected(""); setConfirm(false); }}>Confirm remove all</Button95><Button95 onClick={() => setConfirm(false)}>Keep decorations</Button95></div>}
    {busy && <p role="status">Resizing locally...</p>}{error && <p role="alert">{error}</p>}
  </fieldset>;
}
