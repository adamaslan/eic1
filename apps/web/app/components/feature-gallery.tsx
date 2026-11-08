import { Link } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { Window } from "~/ui95/Window";
import musicCatalog from "~/data/music-library.json";

// Every card names a real route. "public" cards work without a vault; "vault"
// cards redirect to /unlock until the visitor creates or opens their vault.
// Counts come from the real catalog and avatar data so the cards cannot drift.
type Access = "public" | "vault";

interface GalleryFeature {
  title: string;
  blurb: string;
  to: string;
  access: Access;
}

const TRACK_COUNT = musicCatalog.length;
const AVATAR_COUNT = PROFILE_AVATARS.length;

const MAKE_AND_PLAY: GalleryFeature[] = [
  {
    title: "Music library",
    blurb: `${TRACK_COUNT} original songs, free to play. No account, nothing to set up.`,
    to: "/music-library",
    access: "public",
  },
  {
    title: "Paint",
    blurb: "Brushes, shapes, fill, text and undo/redo on a chunky canvas. Save or download your art.",
    to: "/draw",
    access: "vault",
  },
  {
    title: "Hand-drawn avatars",
    blurb: `Pick one of ${AVATAR_COUNT} avatars drawn in Paint. They show up on posts, profiles and the map.`,
    to: "/profile",
    access: "vault",
  },
  {
    title: "Avatar stickers",
    blurb: `Download all ${AVATAR_COUNT} drawn avatars as PNG stickers.`,
    to: "/stickers",
    access: "public",
  },
  {
    title: "Profile Studio",
    blurb: "Decorate your profile with an avatar, a bio, colors and a font.",
    to: "/profile",
    access: "vault",
  },
  {
    title: "Music player",
    blurb: "Play your own MP3s with a queue, shuffle, repeat and playlists. Files stay on your device.",
    to: "/tools/music",
    access: "vault",
  },
];

const FEED_MARKET_FRIENDS: GalleryFeature[] = [
  {
    title: "Photo feed",
    blurb: "Keep photo moments in a private feed. The sample below shows what it looks like.",
    to: "/feed",
    access: "vault",
  },
  {
    title: "Marketplace picks",
    blurb: "Browse your listings and tune picks by category and keyword.",
    to: "/market",
    access: "vault",
  },
  {
    title: "Connections map",
    blurb: "See your people, posts and listings as a map you can rearrange. Enable it in Tools.",
    to: "/graph",
    access: "vault",
  },
  {
    title: "Connect and chat",
    blurb: "Add a friend with a signed card or share file, then swap sealed chat links by hand.",
    to: "/connections",
    access: "vault",
  },
];

const QUIET_TOOLS: GalleryFeature[] = [
  {
    title: "Journal",
    blurb: "Write private entries, encrypted in your vault. Share one only with an explicit link.",
    to: "/tools/journal",
    access: "vault",
  },
  {
    title: "Calendar",
    blurb: "Keep plans on a simple month grid, stored in your vault.",
    to: "/tools/calendar",
    access: "vault",
  },
  {
    title: "Chore chart",
    blurb: "Check off chores and rotate who does what, week by week.",
    to: "/tools/chores",
    access: "vault",
  },
  {
    title: "Rearrangeable home",
    blurb: "Swap the feed, picks and messages boxes on your unlocked home until it feels right.",
    to: "/",
    access: "vault",
  },
];

function ctaLabel(access: Access, unlocked: boolean): string {
  if (access === "public") return "Try now";
  return unlocked ? "Open" : "Open your vault to use";
}

function Card({ feature, unlocked }: { feature: GalleryFeature; unlocked: boolean }) {
  return (
    <Link
      to={feature.to}
      className="block min-h-[44px] bg-white p-2 text-[12px] text-[#0a0a0a] [border:2px_inset_#fff] hover:bg-[#ffffe1]"
    >
      <span className="block font-bold">{feature.title}</span>
      <span className="block">{feature.blurb}</span>
      <span className="mt-1 block text-[11px] text-[#0000cc] underline">{ctaLabel(feature.access, unlocked)}</span>
    </Link>
  );
}

function Group({ title, features, unlocked }: { title: string; features: GalleryFeature[]; unlocked: boolean }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#404040]">{title}</h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <li key={feature.title}>
            <Card feature={feature} unlocked={unlocked} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// The feature gallery: one recognizable card per current feature, with its real
// destination and an honest access label. Rendered on the locked landing and,
// with unlocked labels, on the signed-in landing under the dashboard.
export function FeatureGallery({ unlocked = false }: { unlocked?: boolean }) {
  return (
    <Window title="Everything you can do here">
      <div className="flex flex-col gap-3 text-[12px]">
        {!unlocked && (
          <p className="max-w-prose">
            Music, doodles, avatars and a little desktop of your own. Two things work right away; the rest live inside
            your encrypted vault on this device.
          </p>
        )}
        <Group title="Make and play" features={MAKE_AND_PLAY} unlocked={unlocked} />
        <Group title="Feed, market and friends" features={FEED_MARKET_FRIENDS} unlocked={unlocked} />
        <Group title="Quiet tools" features={QUIET_TOOLS} unlocked={unlocked} />
      </div>
    </Window>
  );
}
