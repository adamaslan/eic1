import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { HANDLE_MAX, timeAgo } from "@veil/core";
import {
  defaultProfile,
  getProfile,
  type Decoration,
  type Profile,
} from "@veil/features";
import type { Route } from "./+types/profile";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
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
  silver: "#c0c0c0",
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
      style={{ background: WALLPAPER_STYLE[profile.theme.wallpaper], color: SCHEME_INK[profile.theme.colorScheme], fontFamily: FONT_STACK[profile.theme.fontChoice] }}
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
        <div className="flex flex-col gap-2">
          {profile.avatar && (
            <img src={`data:${profile.avatar.mime};base64,${profile.avatar.data}`} alt={`${profile.displayName}'s avatar`} className="h-16 w-16 border border-[#808080] object-cover" />
          )}
          <p className="text-[16px] font-bold" style={{ color: ACCENT_COLOR[profile.theme.windowAccent] }}>{profile.displayName}</p>
          {handle && <p className="text-[12px]">@{handle}</p>}
          {isOwn === false && (
            <p className="text-[12px]">
              {verified ? `Signature verified from @${handle}` : "Unsigned - trust the sender"}
              <span className="text-[#404040]"> · profile claims updated {timeAgo(profile.updatedAt, now)} ago</span>
              {importedAt && <span className="text-[#404040]"> · bundle imported {timeAgo(importedAt, now)} ago</span>}
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
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    if (!vault) return;
    void (async () => {
      const settings = social.settings;
      const targetId = authorId ?? settings.authorId;
      if (!targetId) {
        if (live) setMissing(true);
        return;
      }
      const stored = await getProfile(vault, targetId);
      if (!live) return;
      if (stored) {
        setProfile(stored);
      } else if (!authorId && settings.handle) {
        setProfile(defaultProfile(targetId, settings.handle.slice(0, HANDLE_MAX), new Date()));
      } else {
        setMissing(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, authorId]);

  if (!vault) return <p className="text-[12px]">Unlock your vault to view profiles.</p>;
  if (missing) return <p className="text-[12px]">No profile stored here yet.</p>;
  if (!profile) return <p className="text-[12px]">Loading…</p>;

  const isOwn = !authorId || authorId === social.settings.authorId;
  const connection = authorId ? social.connections.find((c) => c.id === authorId) : undefined;
  return (
    <ProfileView
      profile={profile}
      handle={isOwn ? social.settings.handle : (connection?.handle ?? null)}
      nickname={connection?.nickname ?? null}
      isOwn={isOwn}
      verified={isOwn ? null : Boolean(connection?.pubkey)}
      importedAt={connection?.lastImportAt ?? null}
      now={new Date()}
    />
  );
}
