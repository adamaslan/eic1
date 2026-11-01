import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CATEGORIES, type Category } from "@veil/core";
import { selectMarket, useVaultItems, type MarketSort } from "@veil/features";
import type { Route } from "./+types/market";
import { ListingRow } from "~/components/cards";
import { DemoSeed } from "~/components/demo-seed";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Market — Everybody is Cool" }];
}

const SORTS: { value: MarketSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
];
const selectClass = "bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

export default function Market() {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);
  const location = useLocation();
  const navigate = useNavigate();
  // One-shot save notice: capture the flag once, then clear it from history state so a
  // reload or a later Back to this entry does not re-announce a stale success.
  const [justSaved] = useState(() => (location.state as { saved?: boolean } | null)?.saved === true);
  const cleared = useRef(false);
  useEffect(() => {
    if (!justSaved || cleared.current) return;
    cleared.current = true;
    const rest = { ...(location.state as Record<string, unknown> | null) };
    delete rest.saved;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: Object.keys(rest).length > 0 ? rest : null,
    });
  }, [justSaved, location, navigate]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [sort, setSort] = useState<MarketSort>("newest");

  if (state.status === "loading") return <p className="text-[12px]">Loading listings…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const listings = selectMarket(state.items, { query, category, sort });
  const now = new Date();
  const filtered = query !== "" || category !== "all";

  return (
    <div className="flex flex-col gap-2">
      {justSaved && <p role="status" className="text-[12px]">Saved - encrypted in this vault.</p>}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search listings"
          className="min-w-0 flex-1 bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none"
        />
        <select
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category | "all")}
          className={selectClass}
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as MarketSort)} className={selectClass}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {listings.length === 0 && (
        <div className="flex flex-col items-start gap-2 text-[12px] text-[#0a0a0a]">
          <p>{filtered ? "No listings match those filters." : "No listings yet."}</p>
          {!filtered && <DemoSeed onSeeded={reload} />}
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {listings.map((item) => (
          <li key={item.id}>
            <ListingRow item={item} now={now} />
          </li>
        ))}
      </ul>
    </div>
  );
}
