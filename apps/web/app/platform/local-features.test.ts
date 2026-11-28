import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, type Choices } from "./cookie-jar-store";
import { CASSETTE_KEY, hashPath, matchTrack, parseBookmark, saveBookmark, loadBookmark, shouldSave } from "./cassette-bookmark";
import { DESK_KEY, EMPTY_DESK, loadDesk, parseDesk, saveDesk, toggleTray, TRAY_SIZE } from "./desk-memory";
import { readPref, resetMemoryPrefs, writePref, type PrefStores } from "./local-pref";
import { fortuneFor, localDay } from "./sticker-fortune";

function stores(denied = false): PrefStores & { l: Map<string, string>; s: Map<string, string> } {
  const l = new Map<string, string>();
  const s = new Map<string, string>();
  const wrap = (m: Map<string, string>) => ({
    getItem: (k: string) => { if (denied) throw new Error("denied"); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (denied) throw new Error("denied"); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  });
  return { local: wrap(l), session: wrap(s), l, s };
}
const on = (extra: Partial<Choices> = {}, ...ids: string[]): Choices => ({ ...DEFAULT_CHOICES, ...extra, purposes: Object.fromEntries(ids.map((id) => [id, true])) });

beforeEach(resetMemoryPrefs);

describe("local-pref (I-3, I-8)", () => {
  it("writes nothing while a purpose is off", () => {
    const st = stores();
    expect(writePref(on(), "desk-memory", "k", { a: 1 }, st).level).toBe("none");
    expect(st.l.size + st.s.size).toBe(0);
  });
  it("tab-only mode uses sessionStorage, never localStorage", () => {
    const st = stores();
    const result = writePref(on({ deviceMemory: "temporary" }, "desk-memory"), "desk-memory", "k", { a: 1 }, st);
    expect(result.level).toBe("tab");
    expect(st.l.size).toBe(0);
    expect(st.s.get("k")).toBe('{"a":1}');
  });
  it("reports memory, not saved, when storage is denied", () => {
    const choices = on({}, "desk-memory");
    const st = stores(true);
    expect(writePref(choices, "desk-memory", "k", { a: 1 }, st).level).toBe("memory");
    expect(readPref(choices, "desk-memory", "k", (raw) => raw as { a: number }, st)).toEqual({ a: 1 });
  });
  it("drops only a corrupt key and returns null", () => {
    const st = stores();
    st.l.set("k", "{not json");
    expect(readPref(on({}, "desk-memory"), "desk-memory", "k", (raw) => raw, st)).toBeNull();
    expect(st.l.has("k")).toBe(false);
  });
});

describe("desk memory", () => {
  it("round-trips only known sticker ids and tools, capped", () => {
    const st = stores();
    const choices = on({}, "desk-memory");
    saveDesk(choices, { tray: ["not-an-avatar", "<script>"], lastTool: "piano" }, st);
    expect(loadDesk(choices, st)).toEqual({ tray: [], lastTool: "piano" });
    expect(parseDesk({ tray: [], lastTool: "<img onerror>" })).toEqual({ tray: [], lastTool: null });
    expect(EMPTY_DESK.tray).toHaveLength(0);
  });
  it("toggling beyond the tray size drops the oldest", () => {
    let desk = EMPTY_DESK;
    const ids = Array.from({ length: TRAY_SIZE + 2 }, (_, i) => i);
    expect(ids.length).toBeGreaterThan(TRAY_SIZE);
    desk = toggleTray(desk, "nope");
    expect(desk).toBe(EMPTY_DESK);
  });
  it("uses its own key and never the vault or session keys", () => {
    expect(DESK_KEY).toBe("eic.desk.v1");
  });
});

describe("cassette bookmark", () => {
  it("stores a hash and a time, never the path", () => {
    const st = stores();
    const choices = on({}, "cassette-bookmark");
    saveBookmark(choices, { pathHash: hashPath("Mixes/secret name.mp3"), seconds: 83, side: "A" }, st);
    const stored = st.l.get(CASSETTE_KEY) ?? "";
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("mp3");
    expect(loadBookmark(choices, st)).toMatchObject({ seconds: 83 });
  });
  it("rejects malformed bookmarks", () => {
    expect(parseBookmark({ pathHash: "xyz", seconds: 5 })).toBeNull();
    expect(parseBookmark({ pathHash: "0000abcd", seconds: -1 })).toBeNull();
    expect(parseBookmark({ pathHash: "0000abcd", seconds: Infinity })).toBeNull();
  });
  it("matches the right track and ignores a bookmark past the end", () => {
    const tracks = [{ path: "a.mp3", duration: 100 }, { path: "b.mp3", duration: 60 }];
    expect(matchTrack({ pathHash: hashPath("b.mp3"), seconds: 30, side: "A" }, tracks)).toEqual({ index: 1, seconds: 30 });
    expect(matchTrack({ pathHash: hashPath("b.mp3"), seconds: 90, side: "A" }, tracks)).toBeNull();
    expect(matchTrack({ pathHash: hashPath("zzz.mp3"), seconds: 5, side: "A" }, tracks)).toBeNull();
  });
  it("throttles saves", () => {
    expect(shouldSave(null, 0.5)).toBe(false);
    expect(shouldSave(null, 3)).toBe(true);
    expect(shouldSave(10, 12)).toBe(false);
    expect(shouldSave(10, 16)).toBe(true);
  });
});

describe("sticker fortune", () => {
  it("is stable within a day and varies across days, with no storage", () => {
    const a = fortuneFor(new Date(2026, 10, 27, 1));
    expect(fortuneFor(new Date(2026, 10, 27, 23))).toEqual(a);
    const days = new Set(Array.from({ length: 30 }, (_, i) => fortuneFor(new Date(2026, 10, 1 + i)).prompt));
    expect(days.size).toBeGreaterThan(3);
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
