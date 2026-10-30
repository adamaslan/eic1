import { useState } from "react";
import { Link } from "react-router";
import { CATEGORIES, formatPrice, timeAgo, type Category, type Item } from "@veil/core";
import { selectMarket, useVaultItems, type MarketSort } from "@veil/features";
import type { Route } from "./+types/market";
import { Card95 } from "~/ui95/Card95";
import { DemoSeed } from "~/components/demo-seed";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Market — Veil 95" }];
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

function ListingRow({ item, now }: { item: Item; now: Date }) {
  return (
    <Link to={`/item/${item.id}`} className="block">
      <Card95>
        <div className="flex items-baseline gap-2 px-1 py-0.5">
          <span className="min-w-0 flex-1 truncate font-bold text-[#0000cc]">{item.title}</span>
          <span className="shrink-0 font-mono">{formatPrice(item.priceCents)}</span>
        </div>
        <div className="flex gap-2 px-1 pb-0.5 text-[11px] text-[#404040]">
          <span>{item.category}</span>
          <span>· {timeAgo(item.createdAt, now)}</span>
        </div>
      </Card95>
    </Link>
  );
}
