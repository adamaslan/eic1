import { describe, expect, it } from "vitest";
import type { Item } from "@veil/core";
import { selectFeed, selectMarket } from "./selectors";

const make = (overrides: Partial<Item>): Item => ({
  id: "x",
  type: "listing",
  title: "Thing",
  category: "electronics",
  priceCents: 1000,
  description: "",
  createdAt: "2026-10-21T10:00:00.000Z",
  likes: 0,
  mediaIds: [],
  thumbId: null,
  mediaMime: "image/webp",
  schemaVersion: 1,
  ...overrides,
});

const items: Item[] = [
  make({ id: "old-photo", type: "photo", title: "Sunrise", category: "moments", priceCents: null, createdAt: "2026-10-20T10:00:00.000Z" }),
  make({ id: "new-photo", type: "photo", title: "Cat", category: "moments", priceCents: null, createdAt: "2026-10-21T09:00:00.000Z" }),
  make({ id: "cheap", title: "Mug", priceCents: 500, category: "electronics" }),
  make({ id: "pricey", title: "Camera", priceCents: 41000, category: "cameras" }),
  make({ id: "free", title: "Boxes", priceCents: null, category: "free" }),
];

describe("selectFeed", () => {
  it("returns only photos, newest first", () => {
    expect(selectFeed(items, "").map((i) => i.id)).toEqual(["new-photo", "old-photo"]);
  });

  it("filters photos by query, case-insensitively", () => {
    expect(selectFeed(items, "  SUN ").map((i) => i.id)).toEqual(["old-photo"]);
  });
});

describe("selectMarket", () => {
  const base = { query: "", category: "all", sort: "newest" } as const;

  it("returns only listings", () => {
    const ids = selectMarket(items, base).map((i) => i.id);
    expect(ids).not.toContain("new-photo");
    expect(ids.sort()).toEqual(["cheap", "free", "pricey"]);
  });

  it("filters by category", () => {
    expect(selectMarket(items, { ...base, category: "cameras" }).map((i) => i.id)).toEqual(["pricey"]);
  });

  it("sorts by price ascending, free first", () => {
    expect(selectMarket(items, { ...base, sort: "price-asc" }).map((i) => i.id)).toEqual(["free", "cheap", "pricey"]);
  });

  it("sorts by price descending", () => {
    expect(selectMarket(items, { ...base, sort: "price-desc" }).map((i) => i.id)).toEqual(["pricey", "cheap", "free"]);
  });
});
