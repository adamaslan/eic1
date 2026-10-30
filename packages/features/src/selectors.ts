import type { Category, Item } from "@veil/core";

export type MarketSort = "newest" | "price-asc" | "price-desc";

export interface MarketFilters {
  query: string;
  category: Category | "all";
  sort: MarketSort;
}

export function matchesQuery(item: Item, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return item.title.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
}

export function selectFeed(items: Item[], query: string): Item[] {
  return items
    .filter((item) => item.type === "photo" && matchesQuery(item, query))
    .sort(byNewest);
}

export function selectMarket(items: Item[], filters: MarketFilters): Item[] {
  const matching = items.filter(
    (item) =>
      item.type === "listing" &&
      (filters.category === "all" || item.category === filters.category) &&
      matchesQuery(item, filters.query),
  );
  switch (filters.sort) {
    case "price-asc":
      return matching.sort((a, b) => (a.priceCents ?? 0) - (b.priceCents ?? 0));
    case "price-desc":
      return matching.sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0));
    case "newest":
      return matching.sort(byNewest);
  }
}

function byNewest(a: Item, b: Item): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
