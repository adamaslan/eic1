import { describe, expect, it } from "vitest";
import type { Item } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import {
  addNote,
  defaultSettings,
  ensureAuthorId,
  listNotes,
  listConnections,
  loadSettings,
  normalizeKeywords,
  saveSettings,
  selectPicks,
  toggleLike,
} from "./social";
import { getSampleItems } from "./demo-items";

const NOW = new Date("2026-10-29T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");

const listing = (id: string, overrides: Partial<Item> = {}): Item => ({
  ...getSampleItems(NOW)[1]!,
  id,
  ...overrides,
});

describe("selectPicks", () => {
  const items = [
    listing("a", { category: "bikes", title: "Road bike", createdAt: "2026-10-29T10:00:00.000Z" }),
    listing("b", { category: "cameras", title: "Film camera", createdAt: "2026-10-29T11:00:00.000Z" }),
    listing("c", { category: "free", title: "Boxes", createdAt: "2026-10-29T09:00:00.000Z" }),
    listing("d", { category: "electronics", title: "Keyboard", description: "mechanical", createdAt: "2026-10-28T09:00:00.000Z" }),
    getSampleItems(NOW)[0]!,
  ];

  it("returns the newest three listings when there are no preferences", () => {
    const picks = selectPicks(items, { categories: [], keywords: [] });
    expect(picks.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("ranks category matches, then keyword matches, above newer items", () => {
    const picks = selectPicks(items, { categories: ["electronics"], keywords: ["mechanical"] });
    expect(picks[0]!.id).toBe("d");
  });

  it("never returns photos and never more than the limit", () => {
    const picks = selectPicks(items, { categories: [], keywords: [] }, 2);
    expect(picks).toHaveLength(2);
    expect(picks.every((item) => item.type === "listing")).toBe(true);
  });

  it("returns fewer than three when fewer listings exist", () => {
    expect(selectPicks([items[0]!], { categories: [], keywords: [] })).toHaveLength(1);
  });
});

describe("normalizeKeywords", () => {
  it("lowercases, dedupes, drops blanks, and caps at five", () => {
    expect(normalizeKeywords([" Bike ", "bike", "", "a", "b", "c", "d", "e"])).toEqual(["bike", "a", "b", "c", "d"]);
  });
});

describe("settings, likes, and notes in the vault", () => {
  it("falls back to defaults, then round-trips saved settings", async () => {
    const vault = await open();
    expect(await loadSettings(vault)).toEqual(defaultSettings());
    await saveSettings(vault, { ...defaultSettings(), categories: ["bikes"], keywords: ["Steel"], slots: ["picks", "feed", "messages"] });
    const loaded = await loadSettings(vault);
    expect(loaded.categories).toEqual(["bikes"]);
    expect(loaded.keywords).toEqual(["steel"]);
    expect(loaded.slots).toEqual(["picks", "feed", "messages"]);
  });

  it("creates an author id once and keeps it", async () => {
    const vault = await open();
    const first = await ensureAuthorId(vault, await loadSettings(vault), () => "author-one");
    const second = await ensureAuthorId(vault, first, () => "author-two");
    expect(second.authorId).toBe("author-one");
  });

  it("toggles a like on and off without going below zero", async () => {
    const vault = await open();
    const item = { ...listing("x"), likes: 0 };
    await vault.putItem(item);
    const liked = await toggleLike(vault, item);
    expect(liked).toMatchObject({ likedByMe: true, likes: 1 });
    const unliked = await toggleLike(vault, liked);
    expect(unliked).toMatchObject({ likedByMe: false, likes: 0 });
    expect((await vault.getItem("x"))?.likedByMe).toBe(false);
  });

  it("stores notes newest first", async () => {
    const vault = await open();
    let n = 0;
    await addNote(vault, "first", { newId: () => `n${n++}`, now: new Date("2026-10-29T10:00:00Z") });
    await addNote(vault, "second", { newId: () => `n${n++}`, now: new Date("2026-10-29T11:00:00Z") });
    expect((await listNotes(vault)).map((note) => note.text)).toEqual(["second", "first"]);
  });
});

describe("connection deduplication", () => {
  it("keeps the latest addedAt per id regardless of record order and sorts by handle", async () => {
    const vault = await open();
    const connection = (id: string, handle: string, addedAt: string) => ({ id, handle, addedAt, schemaVersion: 1 });
    await vault.putJson("connection", "old-alice", connection("alice", "old", "2026-10-28T12:00:00Z"));
    await vault.putJson("connection", "connection:alice", connection("alice", "alice", "2026-10-29T12:00:00Z"));
    await vault.putJson("connection", "connection:bob", connection("bob", "bob", "2026-10-29T12:00:00Z"));
    await vault.putJson("connection", "old-bob", connection("bob", "stale", "2026-10-28T12:00:00Z"));
    expect((await listConnections(vault)).map(({ id, handle }) => ({ id, handle }))).toEqual([
      { id: "alice", handle: "alice" }, { id: "bob", handle: "bob" },
    ]);
  });
});
