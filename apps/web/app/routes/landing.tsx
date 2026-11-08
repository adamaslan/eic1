import { Link } from "react-router";
import type { Route } from "./+types/landing";
import { Window } from "~/ui95/Window";
import { Bevel } from "~/ui95/Bevel";
import { useSessionStore } from "~/platform/session";
import { BUILD_DATE, BUILD_SHA } from "~/build-info";
import { PROFILE_AVATARS } from "@veil/features";
import { LandingDashboard } from "~/components/landing-dashboard";
import { LandingPreview } from "~/components/landing-preview";
import { FeatureGallery } from "~/components/feature-gallery";
import musicCatalog from "~/data/music-library.json";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Everybody is Cool — a private marketplace that lives on your device" },
    {
      name: "description",
      content:
        "Post photos and listings that are encrypted on your own device with a passphrase only you know. No account, no server, no tracking.",
    },
  ];
}

const FEATURES = [
  {
    title: "Encrypted before it is saved",
    body: "Every post and photo is sealed with AES-256-GCM using a key derived from your passphrase. The contents of posts and photos sit on disk as ciphertext. Record IDs, record types, and the vault creation time are not encrypted.",
  },
  {
    title: "Photos and listings",
    body: "Keep photos in a private feed, draft local listings, and write in a private journal. Nothing is visible to anyone else. Photos are compressed on your device first, so backups stay small.",
  },
  {
    title: "A backup you own",
    body: "Export one encrypted file and restore it in another browser. It still needs your passphrase, but anyone holding the file can try guesses offline, so use a strong, unique passphrase and keep the file somewhere only you can reach.",
  },
];

const FACTS = [
  ["Accounts", "none"],
  ["Servers", "none"],
  ["Tracking", "none"],
  ["Lock", "auto, after 60 idle minutes"],
];

const linkClass = "text-[#0000cc] underline";

export default function Landing() {
  const unlocked = useSessionStore((state) => state.vault !== null);

  if (unlocked) return <UnlockedLanding />;

  return (
    <main className="min-h-screen bg-[#008080] p-3 pb-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <Window title="Everybody is Cool">
          <div className="flex flex-col gap-3 text-[12px]">
            <h1 className="text-[20px] font-bold leading-tight">A private marketplace that lives on your device.</h1>
            <p className="max-w-prose">
              Everybody is Cool is a feed and a classifieds board in one. Everything you post is encrypted with a passphrase only
              you know, and it never leaves this browser unless you export it.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link to="/unlock" className="inline-block min-h-[44px] sm:min-h-0">
                <Bevel variant="out" className="bg-[#c0c0c0]">
                  <span className="block px-4 py-2 text-[13px] font-bold text-[#0a0a0a]">
                    Create or open your vault
                  </span>
                </Bevel>
              </Link>
              <span className="text-[#404040]">Takes a passphrase and about ten seconds.</span>
            </div>
          </div>
        </Window>

        <FeatureGallery />

        <MusicLibraryBox />

        <LandingPreview />

        <Window title="Hand-drawn avatars">
          <div className="flex flex-col gap-2 text-[12px]">
            <p className="max-w-prose">
              Every profile picks one of 20 avatars drawn in the built-in Paint. They show up on posts, profiles and the
              connections graph - the sample feed above already uses them.
            </p>
            <ul aria-label="The 20 drawn avatars" className="flex flex-wrap gap-1.5">
              {PROFILE_AVATARS.map((avatar) => (
                <li key={avatar.id}>
                  <img
                    src={`data:image/png;base64,${avatar.data}`}
                    alt={avatar.label}
                    title={avatar.label}
                    width={36}
                    height={36}
                    className="block object-contain"
                  />
                </li>
              ))}
            </ul>
            <p>
              <Link to="/stickers" className={linkClass}>
                Download all 20 as PNG stickers
              </Link>
            </p>
          </div>
        </Window>

        <section aria-label="Features" className="grid gap-3 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <Window key={feature.title} title={feature.title}>
              <p className="text-[12px]">{feature.body}</p>
            </Window>
          ))}
        </section>

        <Window title="The short version">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            {FACTS.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="font-mono font-bold">{value}</dd>
              </div>
            ))}
          </dl>
        </Window>

        <Window title="Before you start">
          <ul className="list-disc pl-5 text-[12px]">
            <li>If you lose your passphrase, your data cannot be recovered. There is no reset.</li>
            <li>Posts live in this browser only, so nobody else can see them yet.</li>
            <li>Clearing site data deletes the vault. Export a backup first.</li>
          </ul>
        </Window>

        <p className="text-center text-[11px] text-white">
          <Link to="/showcase" className="text-white underline">
            UI kit
          </Link>
          <span className="ml-2 text-[#c0c0c0]" title={`Built ${BUILD_DATE}`}>
            build {BUILD_SHA}
          </span>
        </p>
      </div>
    </main>
  );
}

const NAV = [
  ["/music-library", "music-library"],
  ["/feed", "Feed"],
  ["/market", "Market"],
  ["/compose", "+ Post"],
  ["/tools", "Tools"],
  ["/connections", "Connections"],
  ["/profile", "My profile"],
  ["/vault", "Vault"],
];

// Catalog-derived, so the panel cannot drift from the actual library again.
const MUSIC_TRACK_COUNT = musicCatalog.length;
const MUSIC_FORMATS = [...new Set(musicCatalog.map((track) => track.file.split(".").pop()?.toUpperCase()))].join(" and ");

function MusicLibraryBox() {
  return (
    <Window title="Music library">
      <div className="flex flex-col items-start gap-2 text-[12px] sm:flex-row sm:items-center sm:gap-3">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0 text-[#0a0a0a]" fill="currentColor">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
        <div className="min-w-0 sm:flex-1">
          <p className="font-bold">42b - {MUSIC_TRACK_COUNT} songs, free to play.</p>
          <p>Original {MUSIC_FORMATS} files, unchanged. Listen without signing in - no vault, no account, nothing to set up.</p>
        </div>
        <Link to="/music-library" className="inline-block min-h-[44px] sm:min-h-0">
          <Bevel variant="out" className="bg-[#c0c0c0]">
            <span className="block px-4 py-2 text-[13px] font-bold text-[#0a0a0a]">Open the music library</span>
          </Bevel>
        </Link>
      </div>
    </Window>
  );
}

function UnlockedLanding() {
  const lock = useSessionStore((state) => state.lock);
  return (
    <main className="min-h-screen bg-[#008080] p-3 pb-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-3">
        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-1">
          {NAV.map(([to, label]) => (
            <Link key={to} to={to} className="block min-h-[44px] bg-[#c0c0c0] px-3 py-1 text-[12px] text-[#0a0a0a] [border:2px_outset_#fff] sm:min-h-0">
              {label}
            </Link>
          ))}
          <button type="button" onClick={lock} className="ml-auto min-h-[44px] cursor-pointer bg-[#c0c0c0] px-3 py-1 text-[12px] text-[#0a0a0a] [border:2px_outset_#fff] sm:min-h-0">
            Lock
          </button>
        </nav>
        <MusicLibraryBox />
        <LandingDashboard />
        <FeatureGallery unlocked />
        <p className="text-center text-[11px] text-[#c0c0c0]" title={`Built ${BUILD_DATE}`}>
          build {BUILD_SHA}
        </p>
      </div>
    </main>
  );
}
