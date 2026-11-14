import { describe, expect, it, vi } from "vitest";
import type { Item } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import {
  addNote,
  defaultSettings,
  isFeatureEnabled,
  setFeatureEnabled,
  ensureAuthorId,
  listNotes,
  listConnections,
  loadSettings,
  normalizeKeywords,
  removeConnection,
  saveSettings,
  saveSettingsFields,
  selectPicks,
  setConnectionHidden,
  toggleLike,
} from "./social";
import type { UnlockedVault } from "@veil/vault";
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
    listing("c", { category: "tooling", title: "Boxes", createdAt: "2026-10-29T09:00:00.000Z" }),
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


describe("feature gates", () => {
  it("unknown top-level settings fields and future feature keys survive a save round trip", async () => {
    const vault = await open();
    const base = defaultSettings();
    await vault.putJson("settings", "settings", { ...base, futureField: { nested: 1 }, features: { "future-feature": false } });
    const loaded = await loadSettings(vault);
    expect((loaded as Record<string, unknown>).futureField).toEqual({ nested: 1 });
    expect(loaded.features["future-feature"]).toBe(false);
    await saveSettings(vault, { ...loaded, keywords: ["steel"] });
    const again = await loadSettings(vault);
    expect((again as Record<string, unknown>).futureField).toEqual({ nested: 1 });
    expect(again.features["future-feature"]).toBe(false);
  });

  it("a feature defaults to enabled and stays off only when explicitly disabled", async () => {
    const vault = await open();
    const base = defaultSettings();
    expect(isFeatureEnabled(base, "graph")).toBe(true);
    const off = await setFeatureEnabled(vault, "graph", false);
    expect(isFeatureEnabled(off, "graph")).toBe(false);
    expect(isFeatureEnabled(off, "music")).toBe(true);
  });

  it("concurrent settings writers do not clobber each other's keys", async () => {
    const vault = await open();
    await setFeatureEnabled(vault, "graph", false);
    // A writer holding a stale settings object saves through the CAS path too.
    const stale = await loadSettings(vault);
    await setFeatureEnabled(vault, "music", false);
    const merged = await setFeatureEnabled(vault, "drawing", false);
    expect(isFeatureEnabled(merged, "graph")).toBe(false);
    expect(isFeatureEnabled(merged, "music")).toBe(false);
    expect(isFeatureEnabled(merged, "drawing")).toBe(false);
    expect(isFeatureEnabled(stale, "music")).toBe(true);
  });

  it("a settings write that lands mid-update is merged, not overwritten (CAS retry)", async () => {
    const vault = await open();
    await setFeatureEnabled(vault, "graph", false);
    let intervened = false;
    const wrapped = {
      ...vault,
      putJsonIfUnchanged: async (kind: string, id: string, value: unknown, expected: unknown | null) => {
        if (!intervened) {
          intervened = true;
          // A concurrent writer saves between our read and our write.
          const current = await loadSettings(vault);
          await vault.putJson("settings", "settings", { ...current, handle: "concurrent" });
        }
        return vault.putJsonIfUnchanged(kind, id, value, expected);
      },
    };
    const merged = await setFeatureEnabled(wrapped, "music", false);
    expect(intervened).toBe(true);
    expect(isFeatureEnabled(merged, "music")).toBe(false);
    expect(isFeatureEnabled(merged, "graph")).toBe(false);
    expect(merged.handle).toBe("concurrent");
  });

  it("a stale whole-form saveSettings cannot erase flag changes or unknown fields", async () => {
    const vault = await open();
    await vault.putJson("settings", "settings", { ...defaultSettings(), futureField: "keep-me" });
    const staleForm = { ...(await loadSettings(vault)), keywords: ["bikes"] };
    await setFeatureEnabled(vault, "graph", false);
    const saved = await saveSettings(vault, staleForm);
    expect(saved.keywords).toEqual(["bikes"]);
    expect(isFeatureEnabled(saved, "graph")).toBe(false);
    expect((saved as Record<string, unknown>).futureField).toBe("keep-me");
  });
});

describe("connection write/read consistency", () => {
  const NOW2 = "2026-10-29T12:00:00Z";
  const seedConnection = async (vault: UnlockedVault) => {
    await vault.putJson("connection", "connection:alice", { id: "alice", handle: "alice", addedAt: NOW2, schemaVersion: 1 });
  };
  /** Wraps a vault so putJson for one record kind waits on a test-controlled gate. */
  const gated = (vault: UnlockedVault, kind: string) => {
    let open!: () => void;
    let fail!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    // The gate may settle before the wrapped putJson is ever called; keep it handled.
    void gate.catch(() => undefined);
    const wrapped: UnlockedVault = {
      ...vault,
      putJson: (k, id, value) => (k === kind ? gate.then(() => vault.putJson(k, id, value)) : vault.putJson(k, id, value)),
    };
    return { wrapped, open, fail };
  };
  const settled = (promise: Promise<unknown>) => {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    return () => done;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("a connection read begun after a hide write began waits for it and sees post-write state", async () => {
    const vault = await open();
    await seedConnection(vault);
    const { wrapped, open: release } = gated(vault, "connection");
    const write = setConnectionHidden(wrapped, "alice", true);
    const read = listConnections(wrapped);
    const readSettled = settled(read);
    await tick();
    expect(readSettled()).toBe(false);
    release();
    await write;
    const connections = await read;
    expect(connections).toHaveLength(1);
    expect(connections[0].hidden).toBe(true);
  });

  it("an unrelated note write never blocks a connection read", async () => {
    const vault = await open();
    await seedConnection(vault);
    const { wrapped } = gated(vault, "note");
    const write = addNote(wrapped, "hold this note", { newId: () => "n1", now: new Date("2026-10-29T13:00:00Z") });
    const read = listConnections(wrapped);
    const readSettled = settled(read);
    await tick();
    expect(readSettled()).toBe(true);
    await expect(read).resolves.toHaveLength(1);
    write.catch(() => undefined);
  });

  it("a failed connection write settles the read instead of hanging it", async () => {
    const vault = await open();
    await seedConnection(vault);
    const { wrapped, fail } = gated(vault, "connection");
    const write = setConnectionHidden(wrapped, "alice", true);
    const read = listConnections(wrapped);
    fail(new Error("store exploded"));
    await expect(write).rejects.toThrow("store exploded");
    await expect(read).resolves.toHaveLength(1);
  });

  it("a lock during a pending write surfaces the vault error instead of hanging the read", async () => {
    const vault = await open();
    await seedConnection(vault);
    const { wrapped, open: release } = gated(vault, "connection");
    const write = setConnectionHidden(wrapped, "alice", true);
    vault.lock();
    release();
    await expect(write).rejects.toThrow();
    await expect(listConnections(wrapped)).rejects.toThrow();
  });

  it("a never-settling write only delays the read up to the wait budget, then committed state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const vault = await open();
      await seedConnection(vault);
      const never = new Promise<void>(() => undefined);
      const wrapped: UnlockedVault = { ...vault, putJson: () => never };
      const write = setConnectionHidden(wrapped, "alice", true);
      void write.catch(() => undefined);
      const read = listConnections(wrapped);
      const readSettled = settled(read);
      await vi.advanceTimersByTimeAsync(100);
      expect(readSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(read).resolves.toHaveLength(1);
      const connections = await read;
      expect(connections[0].hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pending write on a wrapped vault does not block a read on the base vault", async () => {
    const vault = await open();
    await seedConnection(vault);
    const { wrapped } = gated(vault, "connection");
    const write = setConnectionHidden(wrapped, "alice", true);
    void write.catch(() => undefined);
    const read = listConnections(vault);
    const readSettled = settled(read);
    await tick();
    expect(readSettled()).toBe(true);
    await expect(read).resolves.toHaveLength(1);
  });

  it("remove registers as a pending connection write too", async () => {
    const vault = await open();
    await seedConnection(vault);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const wrapped: UnlockedVault = {
      ...vault,
      deleteRecords: (ids) => gate.then(() => vault.deleteRecords(ids)),
    };
    const write = removeConnection(wrapped, "alice", { dropPosts: false });
    const read = listConnections(wrapped);
    const readSettled = settled(read);
    await tick();
    expect(readSettled()).toBe(false);
    release();
    await write;
    await expect(read).resolves.toHaveLength(0);
  });
});

describe("saveSettingsFields", () => {
  it("applies the patch onto the fresh record inside the CAS retry: a concurrent writer's unrelated fields survive", async () => {
    const vault = await open();
    await saveSettings(vault, { ...defaultSettings(), authorId: "a1", handle: "h1" });
    // Wrap the vault so the FIRST CAS attempt collides with a concurrent relay-setup
    // write (feedUrl) that lands between the loop's read and its write; later attempts
    // pass through untouched.
    let collided = false;
    const racing: UnlockedVault = {
      ...vault,
      putJsonIfUnchanged: async (kind, id, value, expected) => {
        if (!collided && kind === "settings") {
          collided = true;
          // The concurrent writer saves feedUrl against the record this attempt read.
          const current = (await vault.getJson(id)) as Record<string, unknown>;
          await vault.putJsonIfUnchanged(kind, id, { ...current, feedUrl: "https://relay.example/feed/me" }, current);
          // This attempt then delegates with its now-stale expectation and conflicts.
        }
        return vault.putJsonIfUnchanged(kind, id, value, expected);
      },
    };
    const saved = await saveSettingsFields(racing, { handle: "renamed" });
    expect(collided).toBe(true);
    expect(saved.handle).toBe("renamed");
    expect(saved.feedUrl).toBe("https://relay.example/feed/me");
    const persisted = await loadSettings(vault);
    expect(persisted.handle).toBe("renamed");
    expect(persisted.feedUrl).toBe("https://relay.example/feed/me");
  });

  it("never writes feature flags, even when the patch carries them", async () => {
    const vault = await open();
    await saveSettings(vault, defaultSettings());
    await setFeatureEnabled(vault, "feed", false);
    const saved = await saveSettingsFields(vault, { handle: "h2", features: { feed: true } });
    expect(saved.handle).toBe("h2");
    expect(saved.features.feed).toBe(false);
  });

  it("normalizes patched keywords", async () => {
    const vault = await open();
    await saveSettings(vault, defaultSettings());
    const saved = await saveSettingsFields(vault, { keywords: ["  Tea ", "TEA", "", "books"] });
    expect(saved.keywords).toEqual(["tea", "books"]);
  });
});
