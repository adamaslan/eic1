import { useState } from "react";
import { selectFeed, useVaultItems } from "@veil/features";
import type { Route } from "./+types/feed";
import { PhotoCard } from "~/components/cards";
import { DemoSeed } from "~/components/demo-seed";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Feed — Everybody is Cool" }];
}

export default function Feed() {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);
  const [query, setQuery] = useState("");

  if (state.status === "loading") return <p className="text-[12px]">Loading posts…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const photos = selectFeed(state.items, query);
  const now = new Date();

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search posts"
        className="w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none sm:w-[260px]"
      />
      {photos.length === 0 && (
        <div className="flex flex-col items-start gap-2 text-[12px] text-[#0a0a0a]">
          <p>{query ? "No posts match that search." : "No posts yet."}</p>
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
