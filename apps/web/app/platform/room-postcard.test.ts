import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, type Choices } from "./cookie-jar-store";
import { resetMemoryPrefs, type PrefStores } from "./local-pref";
import { MAX_KEPT, MAX_MESSAGE, POSTCARD_FORMAT, acceptPostcard, buildPostcard, cleanMessage, deleteKept, loadKept, parsePostcard, sendAllowed } from "./room-postcard";

const mem = (): PrefStores => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  return { local: s, session: s };
};
const choices: Choices = { ...DEFAULT_CHOICES, purposes: { "received-postcards": true } };
beforeEach(resetMemoryPrefs);

describe("postcard sender (I-6)", () => {
  it("previews exactly the payload, and the payload carries only the four fields", () => {
    const built = buildPostcard({ wallpaper: "stars", avatarId: "seal", message: "hi from my room" });
    if ("error" in built) throw new Error(built.error);
    expect(JSON.parse(built.payload)).toEqual({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: "hi from my room" });
    expect(built.bytes).toBe(new TextEncoder().encode(built.payload).length);
    expect(built.excluded).toContain("journal entries");
  });
  it("rejects unknown wallpapers and stickers instead of passing free text through", () => {
    expect(buildPostcard({ wallpaper: "x", avatarId: "seal", message: "a" })).toHaveProperty("error");
    expect(buildPostcard({ wallpaper: "stars", avatarId: "../../etc", message: "a" })).toHaveProperty("error");
    expect(buildPostcard({ wallpaper: "stars", avatarId: "seal", message: "   " })).toHaveProperty("error");
  });
  it("cleans control and bidi characters and caps length", () => {
    expect(cleanMessage("a‮b\u0000c")).toBe("a b c");
    expect(cleanMessage("x".repeat(500))).toHaveLength(MAX_MESSAGE);
  });
  it("blocks sending when the audience is Just me", () => {
    expect(sendAllowed("just-me").ok).toBe(false);
    expect(sendAllowed("friends").ok).toBe(true);
    expect(sendAllowed("published-per-item").reason).toMatch(/on purpose/);
  });
});

describe("postcard receiver", () => {
  const valid = JSON.stringify({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: "hello" });
  it("opens a valid postcard", () => {
    expect(parsePostcard(valid)).toMatchObject({ message: "hello" });
  });
  it.each([
    ["extra field", JSON.stringify({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: "a", handle: "me" })],
    ["wrong format", JSON.stringify({ format: "x", v: 1, wallpaper: "stars", avatarId: "seal", message: "a" })],
    ["array", "[]"],
    ["not json", "{nope"],
    ["oversize", JSON.stringify({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: "a".repeat(5000) })],
    ["dirty message", JSON.stringify({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: "a‮b" })],
  ])("refuses %s", (_name, text) => {
    expect(parsePostcard(text)).toHaveProperty("error");
  });
  it("stores nothing until accepted, then keeps at most 20, newest first, de-duplicated", () => {
    const st = mem();
    expect(loadKept(choices, st)).toEqual([]);
    for (let i = 0; i < MAX_KEPT + 3; i += 1) {
      const card = parsePostcard(JSON.stringify({ format: POSTCARD_FORMAT, v: 1, wallpaper: "stars", avatarId: "seal", message: `m${i}` }));
      if ("error" in card) throw new Error(card.error);
      acceptPostcard(choices, card, st);
    }
    const kept = loadKept(choices, st);
    expect(kept).toHaveLength(MAX_KEPT);
    expect(kept[0].message).toBe(`m${MAX_KEPT + 2}`);
    expect(deleteKept(choices, 0, st)).toHaveLength(MAX_KEPT - 1);
  });
  it("does not store while the purpose is off (I-3)", () => {
    const st = mem();
    const card = parsePostcard(valid);
    if ("error" in card) throw new Error(card.error);
    expect(acceptPostcard({ ...DEFAULT_CHOICES, purposes: {} }, card, st).write.level).toBe("none");
  });
});
