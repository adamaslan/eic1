import { useMemo, useState } from "react";
import { Link } from "react-router";
import { formatPrice, timeAgo, type Item } from "@veil/core";
import { getSampleItems, selectFeed, selectPicks } from "@veil/features";
import { Button95 } from "~/ui95/Button95";
import { Tabs95 } from "~/ui95/Tabs95";
import { Window } from "~/ui95/Window";
import { ListingRow, PhotoCard } from "~/components/cards";

const TABS = [
  { id: "feed", label: "Feed" },
  { id: "market", label: "Marketplace" },
  { id: "messages", label: "Messages" },
  { id: "vault", label: "Vault" },
];

const SAMPLE_MESSAGES = [
  "@maya liked \"Fog on 5th Street bridge\".",
  "Imported 4 new and 0 updated posts from @maya.",
  "Note to self: ask about the Peugeot's tires.",
];

const VAULT_FACTS = [
  ["Cipher", "AES-256-GCM"],
  ["Key derivation", "PBKDF2 (SHA-256)"],
  ["Stored", "on this device only"],
  ["Network", "never touched"],
];

// What a visitor sees before they have a vault. Sample data only: nothing here reads or writes the vault,
// IndexedDB, or the network, and nothing typed is kept.
export function LandingPreview() {
  const [tab, setTab] = useState("feed");
  const [open, setOpen] = useState<Item | null>(null);
  const now = useMemo(() => new Date(), []);
  const items = useMemo(() => getSampleItems(now), [now]);
  const photos = selectFeed(items, "");
  const picks = selectPicks(items, { categories: [], keywords: [] });

  return (
    <Window title="Try it — sample content">
      <div className="flex flex-col gap-2 text-[12px]">
        <p className="bg-[#ffffe1] px-1.5 py-1">
          Everything below is <b>sample data</b> so you can look around. Nothing is saved, and nothing leaves this page.
        </p>
        <Tabs95
          tabs={TABS}
          activeId={tab}
          onChange={(id) => {
            setTab(id);
            setOpen(null);
          }}
        />
        {open ? (
          <SampleDetail item={open} now={now} onBack={() => setOpen(null)} />
        ) : (
          <>
            {tab === "feed" && (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {photos.map((item) => (
                  <li key={item.id}>
                    <PhotoCard item={item} now={now} height={110} onOpen={setOpen} />
                  </li>
                ))}
              </ul>
            )}
            {tab === "market" && (
              <>
                <p className="text-[11px] text-[#404040]">Once you sign in, these are matched to the categories and keywords you choose.</p>
                <ul className="flex flex-col gap-1">
                  {picks.map((item) => (
                    <li key={item.id}>
                      <ListingRow item={item} now={now} onOpen={setOpen} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {tab === "messages" && (
              <>
                <p className="text-[11px] text-[#404040]">News from share files you import, and notes to yourself.</p>
                <ul className="flex flex-col gap-1">
                  {SAMPLE_MESSAGES.map((message) => (
                    <li key={message} className="bg-white px-1.5 py-1">{message}</li>
                  ))}
                </ul>
              </>
            )}
            {tab === "vault" && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                {VAULT_FACTS.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt>{label}</dt>
                    <dd className="font-mono font-bold">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
        <div>
          <Link to="/unlock" className="inline-block min-h-[44px] sm:min-h-0">
            <span className="block bg-[#c0c0c0] px-4 py-2 text-[13px] font-bold text-[#0a0a0a] [border:2px_outset_#fff]">
              Create or open your vault
            </span>
          </Link>
        </div>
      </div>
    </Window>
  );
}

function SampleDetail({ item, now, onBack }: { item: Item; now: Date; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-bold">{item.title}</h2>
      <p className="text-[#404040]">
        {item.category} · {formatPrice(item.priceCents)} · {timeAgo(item.createdAt, now)} · ♡ {item.likes}
      </p>
      <p>{item.description}</p>
      <div className="flex flex-wrap gap-2">
        <Button95 onClick={onBack}>Back</Button95>
        <Button95 disabled title="Sign in to use this">♡ Like</Button95>
        <Button95 disabled title="Sign in to use this">Share</Button95>
      </div>
    </div>
  );
}
