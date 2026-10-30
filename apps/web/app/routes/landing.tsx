import { Link } from "react-router";
import type { Route } from "./+types/landing";
import { Window } from "~/ui95/Window";
import { Bevel } from "~/ui95/Bevel";
import { useSessionStore } from "~/platform/session";
import { LandingDashboard } from "~/components/landing-dashboard";
import { LandingPreview } from "~/components/landing-preview";

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
  ["Lock", "auto, after 5 idle minutes"],
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

        <LandingPreview />

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
        </p>
      </div>
    </main>
  );
}

const NAV = [
  ["/feed", "Feed"],
  ["/market", "Market"],
  ["/compose", "+ Post"],
  ["/tools", "Tools"],
  ["/connections", "Connections"],
  ["/vault", "Vault"],
];

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
        <LandingDashboard />
      </div>
    </main>
  );
}
