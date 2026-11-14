import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

// Deps-faithful hook harness (node env): useCallback/useMemo cache by deps exactly like
// React, so a param-stable reload keeps its identity across renders and this test fails
// if the mount effect ever loses the authorId dep again (the e7c3410 route regression:
// chat A -> chat B navigation fired no load and B kept showing A's cached thread).
const hooks = vi.hoisted(() => {
  let state: unknown[] = [];
  let effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  return {
    reset() { effects.forEach((e) => e.cleanup?.()); state = []; effects = []; },
    render() { cursor = 0; effectCursor = 0; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    memo(fn: () => unknown, deps: unknown[]) {
      const index = cursor++;
      const slot = state[index] as { deps: unknown[]; value: unknown } | undefined;
      if (slot && slot.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, slot.deps[i]))) return slot.value;
      const value = fn();
      state[index] = { deps, value };
      return value;
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && previous.deps.length === deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: effect() };
    },
  };
});
vi.mock("react", () => ({
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useRef: hooks.useRef,
  useMemo: (fn: () => unknown, deps: unknown[]) => hooks.memo(fn, deps),
  useCallback: (fn: unknown, deps: unknown[]) => hooks.memo(() => fn, deps),
}));

const vault = {} as UnlockedVault;
const connection = (id: string): Connection => ({
  id,
  handle: `h-${id}`,
  addedAt: "2026-11-13T20:00:00.000Z",
  nickname: null,
  hidden: false,
  lastImportAt: null,
  pubkey: "pk",
  feedUrl: `https://feed.example/${id}`,
  syncSeq: 0,
  syncEtag: null,
  syncPending: false,
  syncRetry: 0,
  syncExhausted: false,
  syncStatus: "",
  syncDetail: "",
  schemaVersion: 1,
});

vi.mock("@veil/features", async (original) => ({
  ...await original<typeof import("@veil/features")>(),
  listChatThread: vi.fn().mockResolvedValue([]),
  markThreadRead: vi.fn().mockResolvedValue(0),
}));
vi.mock("~/platform/session", () => ({ useSessionStore: (select: (state: { vault: UnlockedVault }) => unknown) => select({ vault }) }));
vi.mock("~/platform/use-social", () => ({
  useSocial: () => ({
    items: { status: "ready", items: [] },
    settings: {},
    settingsReady: true,
    notes: [],
    connections: [connection("a"), connection("b")],
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("~/platform/foreground-relay", () => ({
  startForegroundRelay: vi.fn(() => () => {}),
  runForegroundCatchUp: vi.fn(),
}));
vi.mock("~/platform/sync-fetcher", () => ({ detectSyncNetwork: () => "wifi" }));
vi.mock("~/platform/vault-service", () => ({ newItemId: () => "id" }));

import { listChatThread } from "@veil/features";
import Chat from "./chat";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const renderChat = (authorId: string) => { hooks.render(); return Chat({ params: { authorId } } as never); };

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

describe("Chat route thread loading", () => {
  it("loads the thread on mount AND again when the authorId param changes", async () => {
    renderChat("a");
    await flush();
    expect(listChatThread).toHaveBeenCalledWith(vault, "a");
    renderChat("a");
    await flush();
    expect(vi.mocked(listChatThread).mock.calls.filter(([, id]) => id === "a")).toHaveLength(1);
    renderChat("b");
    await flush();
    expect(listChatThread).toHaveBeenCalledWith(vault, "b");
  });
});
