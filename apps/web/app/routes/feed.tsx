import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { selectFeed, useVaultItems } from "@veil/features";
import type { Route } from "./+types/feed";
import { PhotoCard } from "~/components/cards";
import { DemoSeed } from "~/components/demo-seed";
import { useSessionStore } from "~/platform/session";
import { clearSavedNoticeFromHistory } from "~/platform/history-state";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Feed — Everybody is Cool" }];
}

export default function Feed() {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);
  const location = useLocation();
  // The save notice belongs to the history entry that arrived from a save. Keyed on that
  // entry, it hides on any other navigation, including a re-click of this same tab.
  const [savedEntry] = useState(() => ((location.state as { saved?: boolean } | null)?.saved === true ? location.key : null));
  const justSaved = savedEntry !== null && savedEntry === location.key && (location.state as { saved?: boolean } | null)?.saved === true;
  // Once shown, drop the flag from the browser's history entry so a reload or a Back to
  // this entry does not re-announce the save. The React Router location keeps the same key.
  useEffect(() => {
    if (savedEntry === null) return;
    clearSavedNoticeFromHistory(window.history, null);
  }, [savedEntry]);
  const [query, setQuery] = useState("");

  if (state.status === "loading") return <p className="text-[12px]">Loading posts…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const photos = selectFeed(state.items, query);
  const now = new Date();

  return (
    <div className="flex flex-col gap-2">
      {justSaved && <p role="status" className="text-[12px]">Saved - encrypted in this vault.</p>}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search posts"
          className="min-w-0 flex-1 bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none sm:w-[260px] sm:flex-none"
        />
        <Link to="/draw" className="shrink-0 text-[12px] font-bold text-[#0000cc] underline">
          🎨 Paint
        </Link>
      </div>
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
