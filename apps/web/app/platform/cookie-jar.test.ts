import { describe, expect, it, vi } from "vitest";
import { ERASE_CONFIRMATION, clearPreferences, eraseVault, type KeyValueStore } from "./cookie-jar-actions";
import { DEFAULT_CHOICES, PRESETS, applyPreset, purposeEnabled, sanitizeChoices, type PresetId } from "./cookie-jar-store";

function fakeStore(initial: Record<string, string>): KeyValueStore & { dump(): Record<string, string> } {
  const data = { ...initial };
  return {
    get length() { return Object.keys(data).length; },
    key: (index) => Object.keys(data)[index] ?? null,
    removeItem: (key) => { delete data[key]; },
    dump: () => ({ ...data }),
  };
}

describe("clearPreferences (T-4, I-1)", () => {
  const protectedKeys = { "eic.vault-lock": "marker", "eic.vault-activity.v1": "{\"id\":\"a\",\"at\":1}" };

  it("removes preferences and leaves every security key byte-identical", () => {
    const local = fakeStore({ ...protectedKeys, "eic.display.v1": "{}", "eic-graph-pins:v1": "{}", "eic.desk.v1": "{}", "eic.cookiejar.v1": "{}" });
    const session = fakeStore({ "eic.boot.shown.v1": "1", "eic.pendingLink.v2.chat": "x", "eic.relaySaveIntent": "id" });
    const report = clearPreferences(local, session);
    expect(local.dump()).toEqual({ ...protectedKeys, "eic.cookiejar.v1": "{}" });
    expect(session.dump()).toEqual({});
    expect(report.removed).toContain("eic.display.v1");
    expect(report.kept).toEqual([]);
  });

  it("keeps the person's Cookie Jar choices so a reset does not silently re-open purposes", () => {
    const local = fakeStore({ "eic.cookiejar.v1": "{\"v\":1}" });
    clearPreferences(local, fakeStore({}));
    expect(local.dump()).toEqual({ "eic.cookiejar.v1": "{\"v\":1}" });
  });

  it("ignores keys it does not own", () => {
    const local = fakeStore({ "someone-else": "1" });
    clearPreferences(local, fakeStore({}));
    expect(local.dump()).toEqual({ "someone-else": "1" });
  });
});

describe("eraseVault", () => {
  it("does nothing without the typed word", async () => {
    const wipe = vi.fn(async () => undefined);
    expect(await eraseVault({ typed: "erase please", wipe, clearSession: async () => undefined })).toBe("needs-confirmation");
    expect(wipe).not.toHaveBeenCalled();
  });
  it("refuses while locked", async () => {
    expect(await eraseVault({ typed: ERASE_CONFIRMATION, wipe: null, clearSession: async () => undefined })).toBe("locked");
  });
  it("wipes then drops the saved session", async () => {
    const order: string[] = [];
    const outcome = await eraseVault({ typed: ` ${ERASE_CONFIRMATION} `, wipe: async () => { order.push("wipe"); }, clearSession: async () => { order.push("session"); } });
    expect(outcome).toBe("erased");
    expect(order).toEqual(["wipe", "session"]);
  });
});

describe("choices", () => {
  it("defaults keep today's behaviour and start purposes off (I-7)", () => {
    expect(DEFAULT_CHOICES).toMatchObject({ deviceMemory: "preferences", audience: "just-me", measurement: "off" });
    expect(purposeEnabled(DEFAULT_CHOICES, "desk-memory")).toBe(false);
  });

  it.each(Object.keys(PRESETS) as PresetId[])("preset %s never turns measurement on or flips a switch (I-2)", (preset) => {
    const before = { ...DEFAULT_CHOICES, purposes: { "desk-memory": true } };
    const after = applyPreset(before, preset);
    expect(after.measurement).toBe("off");
    expect(after.purposes).toEqual({ "desk-memory": true });
  });

  it("only Showtime publishes, and only per item", () => {
    expect(PRESETS.showtime.audience).toBe("published-per-item");
    expect(PRESETS["pocket-universe"].deviceMemory).toBe("temporary");
    expect(Object.values(PRESETS).filter((p) => p.audience === "published-per-item")).toHaveLength(1);
  });

  it("repairs corrupt input instead of throwing, and cannot smuggle measurement on", () => {
    const clean = sanitizeChoices({ deviceMemory: "forever", audience: 7, measurement: "on", purposes: { "ok-id": true, "BAD ID": true, x: "yes" } });
    expect(clean).toMatchObject({ deviceMemory: "preferences", audience: "just-me", measurement: "off", preset: "custom" });
    expect(clean.purposes).toEqual({ "ok-id": true });
    expect(sanitizeChoices(null)).toEqual(DEFAULT_CHOICES);
  });
});
