import { describe, expect, it } from "vitest";
import { JOURNAL_ENTRY_MAX } from "@veil/core";
import {
  buildJournalShareBundle,
  buildJournalShareLink,
  isJournalShareBundle,
  parseJournalShareBundle,
  saveSharedJournalEntry,
} from "./journal-share";
import { MAX_POST_LINK_CHARS, readPostShareLink } from "./share-link";

const BASE = "https://everybodyiscool.netlify.app/";
const NOW = new Date("2026-11-01T15:00:00Z");

function bundleFor(text: string) {
  return buildJournalShareBundle({
    authorId: "me01",
    authorHandle: "tester",
    text,
    createdAt: "2026-10-31T20:00:00Z",
    now: NOW,
  });
}

describe("journal share links", () => {
  it("round-trips an entry through the fragment channel", () => {
    const link = buildJournalShareLink(bundleFor("Bridge at dawn, worth the cold"), BASE);
    expect(link.startsWith(`${BASE}#import=`)).toBe(true);
    const decoded = readPostShareLink(new URL(link).hash);
    expect(decoded).not.toBeNull();
    expect(isJournalShareBundle(decoded!)).toBe(true);
    const parsed = parseJournalShareBundle(decoded!);
    expect(parsed.entry.text).toBe("Bridge at dawn, worth the cold");
    expect(parsed.entry.createdAt).toBe("2026-10-31T20:00:00Z");
    expect(parsed.author.handle).toBe("tester");
  });

  it("fits a max-length ASCII entry under the cap", () => {
    const link = buildJournalShareLink(bundleFor("a".repeat(JOURNAL_ENTRY_MAX)), BASE);
    expect(link.length).toBeLessThanOrEqual(MAX_POST_LINK_CHARS);
  });

  it("fails honestly when Unicode pushes the final link over the cap - no truncation", () => {
    expect(() => buildJournalShareLink(bundleFor("界".repeat(JOURNAL_ENTRY_MAX)), BASE))
      .toThrowError("That entry is too big for a link. Nothing was shared.");
    expect(() => buildJournalShareLink(bundleFor("😀".repeat(JOURNAL_ENTRY_MAX)), BASE))
      .toThrowError("That entry is too big for a link. Nothing was shared.");
  });

  it("rejects damaged or foreign payloads with an honest message", () => {
    expect(() => parseJournalShareBundle("not json")).toThrowError("That shared entry is damaged.");
    expect(() => parseJournalShareBundle(JSON.stringify({ type: "journal-entry" })))
      .toThrowError("That shared entry is damaged.");
    expect(isJournalShareBundle("not json")).toBe(false);
    expect(isJournalShareBundle(JSON.stringify({ format: "eic-share", version: 1, posts: [] }))).toBe(false);
  });
});

describe("saveSharedJournalEntry", () => {
  it("saves a copy with a new id and the original text and date", async () => {
    const { createVault } = await import("@veil/vault");
    const { MemoryStore } = await import("../../vault/src/memory-store");
    const { SubtleCryptoPort } = await import("@veil/crypto");
    const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "pass phrase 1");
    const bundle = parseJournalShareBundle(bundleFor("The river kept flashing."));
    const copy = await saveSharedJournalEntry(vault, bundle, { newId: () => "copy01" });
    expect(copy.id).toBe("journal:copy01");
    expect(copy.text).toBe("The river kept flashing.");
    expect(copy.createdAt).toBe("2026-10-31T20:00:00Z");
    const { listJournal } = await import("./journal");
    const entries = await listJournal(vault);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The river kept flashing.");
  });
});
