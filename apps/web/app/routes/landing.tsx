import { Link } from "react-router";
import type { Route } from "./+types/landing";
import { Window } from "~/ui95/Window";
import { Bevel } from "~/ui95/Bevel";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Veil 95 — a private marketplace that lives on your device" },
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
    body: "Every post and photo is sealed with AES-256-GCM using a key derived from your passphrase. What sits on disk is ciphertext.",
  },
  {
    title: "Photos and listings",
    body: "Share moments in a feed, or list something for sale or free. Photos are compressed on your device first, so backups stay small.",
  },
  {
    title: "A backup you own",
    body: "Export one encrypted file and restore it in another browser. It still needs your passphrase, so the file is safe to store anywhere.",
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
  const ctaTarget = unlocked ? "/feed" : "/unlock";

  return (
    <main className="min-h-screen bg-[#008080] p-3 pb-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <Window title="Veil 95">
          <div className="flex flex-col gap-3 text-[12px]">
            <h1 className="text-[20px] font-bold leading-tight">A private marketplace that lives on your device.</h1>
            <p className="max-w-prose">
              Veil 95 is a feed and a classifieds board in one. Everything you post is encrypted with a passphrase only
              you know, and it never leaves this browser unless you export it.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link to={ctaTarget} className="inline-block min-h-[44px] sm:min-h-0">
                <Bevel variant="out" className="bg-[#c0c0c0]">
                  <span className="block px-4 py-2 text-[13px] font-bold text-[#0a0a0a]">
                    {unlocked ? "Open your desktop" : "Create or open your vault"}
                  </span>
                </Bevel>
              </Link>
              <span className="text-[#404040]">Takes a passphrase and about ten seconds.</span>
            </div>
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
        </p>
      </div>
    </main>
  );
}
