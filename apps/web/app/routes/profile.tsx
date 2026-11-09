import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AppError, timeAgo } from "@veil/core";
import {
  buildConnectLink,
  loadSettings,
  loadProfileDraft,
  selectedProfile,
  type ProfileDraft,
  getProfile,
  type Decoration,
  type Profile,
} from "@veil/features";
import type { Route } from "./+types/profile";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { useSessionStore } from "~/platform/session";
import { ProfileStudio } from "~/components/profile-studio";
import { useSocial } from "~/platform/use-social";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Profile — Everybody is Cool" }];
}

// Theme enums are the whole theme: the enum value picks a built-in CSS treatment, no asset bytes.
const WALLPAPER_STYLE: Record<Profile["theme"]["wallpaper"], string> = {
  teal: "#008080",
  clouds: "#5f9ea0",
  dither: "#404040",
  none: "#c0c0c0",
};
const SCHEME_INK: Record<Profile["theme"]["colorScheme"], string> = {
  win95: "#0a0a0a",
  vapor: "#2a0a4a",
  midnight: "#e0e0ff",
  "hot-dog-stand": "#ffff00",
};
const ACCENT_COLOR: Record<Profile["theme"]["windowAccent"], string> = {
  blue: "#000080",
  silver: "#404040",
  magenta: "#800080",
  lime: "#008000",
};
const FONT_STACK: Record<Profile["theme"]["fontChoice"], string> = {
  "ms-sans": "Tahoma, Verdana, sans-serif",
  fixed: "Courier New, monospace",
  pixel: "monospace",
};

/** A decoration asset always renders inside <img>: SVG loaded through <img> cannot run scripts or fetch external resources. */
function decorationSrc(decoration: Decoration): string {
  if (decoration.asset.kind === "inline-svg") {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(decoration.asset.data)))}`;
  }
  return `data:${decoration.asset.mime};base64,${decoration.asset.data}`;
}

// Pure presentational half, exported for render tests. Renders from local vault data only -
// zero network requests beyond permitted ciphertext feed fetches.
export function ProfileView({
  profile,
  handle,
  nickname,
  isOwn,
  verified,
  importedAt,
  now,
}: {
  profile: Profile;
  handle: string | null;
  nickname: string | null;
  isOwn: boolean;
  verified: boolean | null;
  importedAt: string | null;
  now: Date;
}) {
  const sorted = [...profile.decorations].sort((a, b) => a.position.z - b.position.z);
  return (
    <div
      className="relative min-h-[240px] overflow-hidden p-3"
      data-testid="profile-canvas"
      style={{ paddingTop: profile.decorations.length ? 52 : undefined, background: WALLPAPER_STYLE[profile.theme.wallpaper], color: SCHEME_INK[profile.theme.colorScheme], fontFamily: FONT_STACK[profile.theme.fontChoice] }}
    >
      {sorted.map((decoration) => (
        <img
          key={decoration.id}
          src={decorationSrc(decoration)}
          alt={decoration.kind}
          className="pointer-events-none absolute"
          style={{
            left: `${decoration.position.x * 100}%`,
            top: `${decoration.position.y * 100}%`,
            transform: `translate(-50%, -50%) rotate(${decoration.rotation}deg) scale(${decoration.scale})`,
          }}
        />
      ))}
      <Window title={isOwn ? "My Profile" : `${nickname ?? handle ?? profile.displayName}'s profile`} className="relative mx-auto max-w-[420px]">
        <div className="flex flex-col gap-2" style={{ fontFamily: FONT_STACK[profile.theme.fontChoice] }}>
          {profile.avatar && (
            <img src={`data:${profile.avatar.mime};base64,${profile.avatar.data}`} alt={`${profile.displayName}'s avatar`} className="h-16 w-16 border border-[var(--w95-shade)] object-cover" />
          )}
          <p className="text-[16px] font-bold" style={{ color: ACCENT_COLOR[profile.theme.windowAccent] }}>{profile.displayName}</p>
          {handle && <p className="text-[12px]">@{handle}</p>}
          {isOwn === false && (
            <p className="text-[12px]">
              {verified ? `Signature verified from @${handle}` : "Unsigned - trust the sender"}
              <span className="text-[var(--w95-muted)]"> · profile claims updated {timeAgo(profile.updatedAt, now)} ago</span>
              {importedAt && <span className="text-[var(--w95-muted)]"> · bundle imported {timeAgo(importedAt, now)} ago</span>}
            </p>
          )}
          {profile.bio && <p className="whitespace-pre-wrap text-[12px]">{profile.bio}</p>}
          {isOwn && (
            <p className="text-[12px]">
              <Link to="/connections" className="underline">Back to connections</Link>
            </p>
          )}
        </div>
      </Window>
    </div>
  );
}

export default function ProfileRoute() {
  const vault = useSessionStore((state) => state.vault);
  const social = useSocial(vault);
  const { authorId } = useParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [failure, setFailure] = useState("");
  const [ownerHandle, setOwnerHandle] = useState<string | null>(null);
  const [classic, setClassic] = useState(false);
  const [missing, setMissing] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  // Share profile = the connect link (handle + key) PLUS a display-only preview (display
  // name, bio). Avatar, theme and decorations are never stuffed into a link: they reach the
  // recipient as the signed feed profile chunk after they connect. Always an explicit tap.
  async function shareProfile() {
    if (!vault || sharing) return;
    setSharing(true);
    setShareNote(null);
    try {
      const settings = await loadSettings(vault);
      if (!settings.authorId || !settings.handle) throw new AppError("Choose a handle before sharing your profile.");
      const ownDraft = await loadProfileDraft(vault);
      // Only the explicitly selected (feed) fields may leave the vault: the private draft
      // bio/avatar stay private even here. selectedProfile enforces that choice.
      const shared = selectedProfile(ownDraft, settings.handle);
      const link = await buildConnectLink(vault, `${window.location.origin}/`, new Date(), {
        displayName: shared.displayName,
        bio: shared.bio,
      });
      const text = `eic 💌 ${link}`;
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ text });
          setShareNote("Profile link shared - one tap shows your preview and lets them connect.");
          return;
        } catch (shareError) {
          if (shareError instanceof DOMException && shareError.name === "AbortError") {
            setShareNote("Share cancelled - the link was not sent.");
            return;
          }
        }
      }
      await navigator.clipboard.writeText(text);
      setShareNote("Profile link copied - text it to a friend. One tap shows your preview and lets them connect.");
    } catch (caught) {
      setShareNote(caught instanceof AppError ? caught.message : "Your profile link could not be shared. Please try again.");
    } finally {
      setSharing(false);
    }
  }

  useEffect(() => {
    let live = true;
    if (!vault) return;
    setProfile(null); setDraft(null); setMissing(false); setFailure("");
    void (async () => {
      const settings = await loadSettings(vault);
      if (!live) return;
      setOwnerHandle(settings.handle);
      const targetId = authorId ?? settings.authorId;
      if (!targetId) {
        if (live) setMissing(true);
        return;
      }
      if (!authorId || authorId === settings.authorId) {
        const ownDraft = await loadProfileDraft(vault);
        if (live) { setDraft(ownDraft); setProfile(ownDraft.profile); }
        return;
      }
      const stored = await getProfile(vault, targetId);
      if (!live) return;
      if (stored) {
        setProfile(stored);
      } else {
        setMissing(true);
      }
    })().catch((e) => { if (live) setFailure(e instanceof Error ? e.message : "Could not load this profile. Try again later."); });
    return () => {
      live = false;
    };
  }, [vault, authorId]);

  if (!vault) return <p className="text-[12px]">Unlock your vault to view profiles.</p>;
  if (failure) return <p role="alert" className="text-[12px]">{failure} <Link to="/connections" className="underline">Connections</Link></p>;
  if (missing) return <p className="text-[12px]">No profile stored here yet.</p>;
  if (!profile) return <p className="text-[12px]">Loading…</p>;

  const isOwn = !!draft;
  // What the share link may name: the SELECTED feed fields only (never the private draft).
  const shareSelection = (() => {
    if (!draft || !ownerHandle) return null;
    try { return selectedProfile(draft, ownerHandle); } catch { return null; }
  })();
  const connection = authorId ? social.connections.find((c) => c.id === authorId) : undefined;
  const preview = (value: Profile) => <ProfileView profile={value} handle={ownerHandle} nickname={null} isOwn verified={null} importedAt={null} now={new Date()} />;
  return (
    <div className="flex flex-col gap-3">
    {isOwn && <div className="flex gap-2 text-[12px]"><label><input type="checkbox" checked={classic} onChange={e => setClassic(e.target.checked)} /> Classic profile view (hide editor, keep saved data)</label><Link to="/" className="underline">Home</Link></div>}
    {isOwn && !classic && draft && ownerHandle && <ProfileStudio key={draft.profile.authorId} initial={draft} vault={vault} handle={ownerHandle} renderPreview={preview} onSaved={(next) => { setDraft(next); setProfile(next.profile); }} />}
    {isOwn && (
      <Window title="Share profile">
        <div className="flex flex-col gap-1 text-[12px]">
          <p className="font-bold">What the link includes:</p>
          <ul className="list-disc pl-5">
            <li>Your handle{ownerHandle ? ` (@${ownerHandle})` : ""} and display name ({shareSelection?.displayName ?? profile.displayName}){shareSelection && shareSelection.bio !== "" ? ", plus your selected bio" : ""} as an unsigned preview - they are told it is not verified.</li>
            <li>Your signed connect card - public key, no posts, no secrets. The handle and key are what their app verifies.</li>
            <li>Avatar, theme and decorations are NOT in the link; your selected versions can reach them through a later feed sync or share import.</li>
          </ul>
          <p className="text-[var(--w95-muted)]">Anyone who gets the link can read it - share it directly with the person, not in a group.</p>
          <div className="flex items-center gap-2">
            <Button95 onClick={() => void shareProfile()} disabled={sharing || !ownerHandle}>{sharing ? "Sharing…" : "Share profile"}</Button95>
            {!ownerHandle && <span className="text-[#800000]">Save a handle on Connections first.</span>}
          </div>
          {shareNote && <p role="status" className="text-[var(--w95-muted)]">{shareNote}</p>}
        </div>
      </Window>
    )}
    {isOwn && <p className="text-[12px]">Saved private draft (not your selected feed preview)</p>}
    <ProfileView
      profile={profile}
      handle={isOwn ? ownerHandle : (connection?.handle ?? null)}
      nickname={connection?.nickname ?? null}
      isOwn={isOwn}
      verified={isOwn ? null : Boolean(connection?.pubkey)}
      importedAt={connection?.lastImportAt ?? null}
      now={new Date()}
    />
    {isOwn && draft?.song && <p className="text-[12px]">Favorite song (private draft): {draft.song}</p>}
    {isOwn && draft?.book && <p className="text-[12px]">Favorite book (private draft): {draft.book}</p>}
    </div>
  );
}
