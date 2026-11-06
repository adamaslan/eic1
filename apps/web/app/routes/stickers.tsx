import { Link } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { Window } from "~/ui95/Window";

export function meta() { return [{ title: "Avatar stickers - Everybody is Cool" }]; }
export default function Stickers() {
  return <main className="min-h-screen bg-[#008080] p-2"><Window title="Avatar stickers">
    <div className="flex flex-col gap-3 text-[12px]">
      <Link to="/" className="underline">Home</Link>
      <p>Download the original 96 x 96 PNG images. Use them as pictures or import them into a sticker app that accepts PNG. These are image files, not an installed iMessage or WhatsApp sticker pack. Original backgrounds are preserved.</p>
      <p>No sign-in or private profile data needed. Downloading does not change or share your avatar.</p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">{PROFILE_AVATARS.map(avatar => <li key={avatar.id} className="flex flex-col items-center gap-2 border border-[#808080] p-2">
        <img src={`data:image/png;base64,${avatar.data}`} alt={avatar.label} width={96} height={96} />
        <a className="min-h-[44px] underline" href={`data:image/png;base64,${avatar.data}`} download={`eic-sticker-${avatar.id}.png`}>Download {avatar.label} PNG</a>
      </li>)}</ul>
    </div>
  </Window></main>;
}
