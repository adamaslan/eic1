import { describe, expect, it } from "vitest";
import type { Connection, Item, JournalEntry } from "@veil/core";
import { buildVaultExport, describeExport, EXPORT_FORMAT, EXPORT_VERSION, type ExportSelection } from "./export";

const item = (overrides: Partial<Item> = {}): Item => ({
  id: "i1", type: "photo", title: "Rooftop", category: "general", priceCents: null,
  description: "", createdAt: "2026-10-31T00:00:00Z", likes: 0, mediaIds: [], thumbId: null,
  mediaMime: "image/webp", visibility: "private", authorId: null, authorHandle: null,
  likedByMe: false, likedBy: [], schemaVersion: 1, ...overrides,
});
const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "journal:j1", text: "dear diary", createdAt: "2026-10-31T00:00:00Z", schemaVersion: 1, ...overrides,
});
const conn = (overrides: Partial<Connection> = {}): Connection => ({
  id: "c1", handle: "sunny", addedAt: "2026-10-01T00:00:00Z", nickname: null, hidden: false,
  lastImportAt: null, pubkey: null, feedUrl: null, syncSeq: 0, syncEtag: null,
  syncPending: false, syncRetry: 0, syncExhausted: false, syncStatus: "", syncDetail: "",
  schemaVersion: 1, ...overrides,
});
const all: ExportSelection = { items: true, journal: true, connections: true };

describe("buildVaultExport", () => {
  it("builds a schema-valid bundle with only the selected categories", () => {
    const bundle = buildVaultExport({
      handle: "me",
      items: [item(), item({ id: "i2", visibility: "shareable" })],
      journal: [entry()],
      connections: [conn()],
      selection: { items: true, journal: false, connections: true },
      now: new Date("2026-11-01T12:00:00Z"),
    });
    expect(bundle.format).toBe(EXPORT_FORMAT);
    expect(bundle.version).toBe(EXPORT_VERSION);
    expect(bundle.items).toHaveLength(2);
    expect(bundle.journal).toHaveLength(0);
    expect(bundle.connections).toHaveLength(1);
    expect(bundle.handle).toBe("me");
  });

  it("never silently includes unselected categories, even when data exists", () => {
    const bundle = buildVaultExport({
      handle: null, items: [item()], journal: [entry()], connections: [conn()],
      selection: { items: false, journal: false, connections: false },
      now: new Date("2026-11-01T12:00:00Z"),
    });
    expect(bundle.items).toHaveLength(0);
    expect(bundle.journal).toHaveLength(0);
    expect(bundle.connections).toHaveLength(0);
    expect(describeExport(bundle)).toBe("nothing");
  });

  it("keeps private items in the export when items are selected: export is the owner's archive", () => {
    const bundle = buildVaultExport({
      handle: "me", items: [item({ visibility: "private" })], journal: [], connections: [],
      selection: { ...all, journal: false, connections: false }, now: new Date("2026-11-01T12:00:00Z"),
    });
    expect(bundle.items[0].visibility).toBe("private");
  });

  it("keeps hidden connections and their local fields, marked by the hidden flag", () => {
    const bundle = buildVaultExport({
      handle: "me", items: [], journal: [], connections: [conn({ hidden: true, nickname: "Sun" })],
      selection: { items: false, journal: false, connections: true }, now: new Date("2026-11-01T12:00:00Z"),
    });
    expect(bundle.connections[0].hidden).toBe(true);
    expect(bundle.connections[0].nickname).toBe("Sun");
  });

  it("describeExport counts honestly", () => {
    const bundle = buildVaultExport({
      handle: "me", items: [item()], journal: [entry(), entry({ id: "journal:j2" })], connections: [],
      selection: all, now: new Date("2026-11-01T12:00:00Z"),
    });
    expect(describeExport(bundle)).toBe("1 post or listing, 2 journal entries");
  });
});
