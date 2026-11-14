import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

// A small hook runner keeps these async state/effect tests in Vitest's node environment.
const hooks = vi.hoisted(() => {
  let state: unknown[] = [];
  let cursor = 0;
  let effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  let effectCursor = 0;
  return {
    reset() { effects.forEach((e) => e.cleanup?.()); state = []; effects = []; },
    render() { cursor = 0; effectCursor = 0; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: effect() };
    },
  };
});
vi.mock("react", () => ({
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@veil/features", async (original) => ({
  ...await original<typeof import("@veil/features")>(),
  loadSettings: vi.fn(), listNotes: vi.fn(), listConnections: vi.fn(), saveSettingsFields: vi.fn(),
  useVaultItems: () => ({ state: { status: "ready", items: [] }, reload: vi.fn() }),
}));
import { changedSettingsFields, defaultSettings, listConnections, listNotes, loadSettings, saveSettingsFields } from "@veil/features";
import { useSocial } from "./use-social";

const vault = {} as UnlockedVault;
const settings: Settings = { ...defaultSettings(), authorId: "keep-id", handle: "keep-handle" };
// eslint-disable-next-line react-hooks/rules-of-hooks -- test harness drives the hook through a mocked React, not a component
const render = (current: UnlockedVault | null = vault) => { hooks.render(); return useSocial(current); };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  hooks.reset();
  vi.resetAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(settings);
  vi.mocked(listNotes).mockResolvedValue([]);
  vi.mocked(listConnections).mockResolvedValue([]);
  vi.mocked(saveSettingsFields).mockImplementation(async (_vault, fields) => ({ ...settings, ...fields }));
});

describe("settings readiness", () => {
  it("keeps the newer refreshed revision when an earlier save finishes late", async () => {
    render();
    await flush();
    const social = render();
    let resolve!: (settings: Settings) => void;
    vi.mocked(saveSettingsFields).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const saving = social.update({ ...settings, keywords: ["old save"] });
    const refreshed = { ...settings, keywords: ["refreshed"] };
    vi.mocked(loadSettings).mockResolvedValueOnce(refreshed);
    social.refresh();
    render();
    await flush();
    expect(render().settingsReady).toBe(true);
    resolve({ ...settings, keywords: ["old save"] });
    await saving;
    expect(render().settingsReady).toBe(true);
    expect(render().settings).toEqual(refreshed);
  });

  it("blocks updates until settings have loaded, preserving identity", async () => {
    let resolve!: (settings: Settings) => void;
    vi.mocked(loadSettings).mockReturnValue(new Promise((done) => { resolve = done; }));
    let social = render();
    expect(social.settingsReady).toBe(false);
    await social.update(defaultSettings());
    expect(saveSettingsFields).not.toHaveBeenCalled();
    resolve(settings);
    await flush();
    social = render();
    expect(social.settingsReady).toBe(true);
    expect(social.settings).toEqual(settings);
    await social.update({ ...social.settings, keywords: ["bike"] });
    expect(saveSettingsFields).toHaveBeenCalledWith(vault, { keywords: ["bike"] });
  });

  it.each(["notes", "connections"])("loads settings even when %s fail", async (source) => {
    vi.mocked(source === "notes" ? listNotes : listConnections).mockRejectedValue(new Error("unreadable"));
    render();
    await flush();
    const social = render();
    expect(social.settingsReady).toBe(true);
    expect(social.settings).toEqual(settings);
    await social.update(settings);
    // Nothing differs from the caller's base: the patch is empty, nothing is written.
    expect(saveSettingsFields).toHaveBeenCalledWith(vault, {});
  });

  it("does not wait for a pending notes source", async () => {
    vi.mocked(listNotes).mockReturnValue(new Promise(() => {}));
    render();
    await flush();
    expect(render().settingsReady).toBe(true);
  });

  it("keeps writes blocked after a settings failure while other sources load", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("unreadable"));
    render();
    await flush();
    const social = render();
    expect(social.settingsReady).toBe(false);
    await social.update(defaultSettings());
    expect(saveSettingsFields).not.toHaveBeenCalled();
    expect(listNotes).toHaveBeenCalled();
    expect(listConnections).toHaveBeenCalled();
  });

  it("does not carry readiness into a different vault or accept its stale read", async () => {
    let resolve!: (settings: Settings) => void;
    vi.mocked(loadSettings).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render();
    const other = {} as UnlockedVault;
    const social = render(other);
    expect(social.settingsReady).toBe(false);
    await social.update(defaultSettings());
    expect(saveSettingsFields).not.toHaveBeenCalled();
    await flush();
    resolve({ ...settings, authorId: "stale-id" });
    await flush();
    expect(render(other).settings.authorId).toBe("keep-id");
    expect(render(null).settingsReady).toBe(false);
  });
});

describe("changedSettingsFields", () => {
  it("includes only fields whose value differs from the caller's base", () => {
    const base = { ...settings, feedUrl: null };
    // The caller toggled one flag from its stale cached copy; everything else is
    // unchanged even if the persisted record moved on since the base was cached.
    const next = { ...base, syncOnCellular: !base.syncOnCellular };
    expect(changedSettingsFields(base, next)).toEqual({ syncOnCellular: next.syncOnCellular });
  });

  it("keeps an intentional feedUrl change the caller made", () => {
    const base = { ...settings, feedUrl: "https://old.example/a" };
    const next = { ...base, feedUrl: "https://new.example/b" };
    expect(changedSettingsFields(base, next)).toEqual({ feedUrl: "https://new.example/b" });
  });

  it("compares array fields by content: a rebuilt-but-equal keywords array is unchanged", () => {
    // PicksEditor builds a fresh keywords array on every submit; identity comparison
    // would count it as changed and overwrite keywords another tab saved meanwhile.
    const base = { ...settings, keywords: ["a", "b"] };
    const next = { ...base, keywords: ["a", "b"] };
    expect(next.keywords).not.toBe(base.keywords);
    expect(changedSettingsFields(base, next)).toEqual({});
  });

  it("counts genuinely edited keywords as changed", () => {
    const base = { ...settings, keywords: ["a"] };
    const next = { ...base, keywords: ["a", "c"] };
    expect(changedSettingsFields(base, next)).toEqual({ keywords: ["a", "c"] });
  });
});

describe("cross-tab settings writes", () => {
  it("a settings save from a stale screen does not wipe a feedUrl written elsewhere", async () => {
    render();
    await flush();
    const social = render();
    expect(social.settingsReady).toBe(true);
    // Relay feed setup (or another tab) writes feedUrl after this screen cached settings.
    // The save must patch ONLY the toggled field inside the CAS loop, so the concurrent
    // feedUrl is never even read into the write.
    const persisted = { ...settings, feedUrl: "https://relay.example/feed/me" };
    vi.mocked(loadSettings).mockResolvedValue(persisted);
    await social.update({ ...social.settings, syncOnCellular: !social.settings.syncOnCellular });
    expect(saveSettingsFields).toHaveBeenCalledWith(vault, {
      syncOnCellular: !settings.syncOnCellular,
    });
  });
});
