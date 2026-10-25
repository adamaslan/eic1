import { useState } from "react";
import { Link } from "react-router";
import { hueFor, timeAgo, type Item } from "@veil/core";
import { selectFeed, useVaultItems } from "@veil/features";
import type { Route } from "./+types/feed";
import { Card95 } from "~/ui95/Card95";
import { DemoSeed } from "~/components/demo-seed";
import { useMediaUri } from "~/platform/use-media-uri";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Feed — Veil 95" }];
}

export default function Feed() {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);
  const [query, setQuery] = useState("");

  if (state.status === "loading") return <p className="text-[12px]">Loading moments…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const photos = selectFeed(state.items, query);
  const now = new Date();

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search moments"
        className="w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none sm:w-[260px]"
      />
      {photos.length === 0 && (
        <div className="flex flex-col items-start gap-2 text-[12px] text-[#0a0a0a]">
          <p>{query ? "No moments match that search." : "No moments yet."}</p>
          {!query && <DemoSeed onSeeded={reload} />}
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {photos.map((item) => (
          <li key={item.id}>
            <PhotoCard item={item} now={now} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhotoCard({ item, now }: { item: Item; now: Date }) {
  const vault = useSessionStore((state) => state.vault);
  const thumbUri = useMediaUri(vault, item.thumbId, item.mediaMime);
  const hue = hueFor(item.id);
  return (
    <Link to={`/item/${item.id}`} className="block">
      <Card95>
        {thumbUri ? (
          <img src={thumbUri} alt={item.title} className="h-[160px] w-full object-cover" />
        ) : (
          <div
            className="h-[160px] w-full"
            style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 60%), hsl(${(hue + 40) % 360} 70% 35%))` }}
            aria-hidden="true"
          />
        )}
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <span className="truncate font-bold">{item.title}</span>
          <span className="shrink-0 text-[#0000cc]">
            {timeAgo(item.createdAt, now)} · ♥ {item.likes}
          </span>
        </div>
      </Card95>
    </Link>
  );
}
