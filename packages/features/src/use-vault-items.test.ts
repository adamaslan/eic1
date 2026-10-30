import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "@veil/core";
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

import { useVaultItems } from "./use-vault-items";
const render = (vault: UnlockedVault | null) => { hooks.render(); return useVaultItems(vault); };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => hooks.reset());

describe("vault item reloads", () => {
  it("keeps ready items mounted while a reload is pending", async () => {
    const items = [{ id: "photo" }] as Item[];
    const listItems = vi.fn().mockResolvedValueOnce(items);
    const vault = { listItems } as unknown as UnlockedVault;
    expect(render(vault).state.status).toBe("loading");
    await flush();
    const loaded = render(vault);
    expect(loaded.state).toEqual({ status: "ready", items });
    let resolve!: (items: Item[]) => void;
    listItems.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    loaded.reload();
    expect(render(vault).state).toBe(loaded.state);
    expect(render(vault).state).toBe(loaded.state);
    const updated = [{ id: "photo", likes: 1 }] as Item[];
    resolve(updated);
    await flush();
    expect(render(vault).state).toEqual({ status: "ready", items: updated });
  });

  it("hides prior items on a vault change and ignores its pending reload", async () => {
    const listItems = vi.fn().mockResolvedValueOnce([{ id: "old" }]);
    const vault = { listItems } as unknown as UnlockedVault;
    render(vault);
    await flush();
    let resolve!: (items: Item[]) => void;
    listItems.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(vault).reload();
    render(vault);
    const other = { listItems: vi.fn().mockResolvedValue([{ id: "new" }]) } as unknown as UnlockedVault;
    expect(render(other).state.status).toBe("loading");
    await flush();
    resolve([{ id: "stale" }] as Item[]);
    await flush();
    expect(render(other).state).toEqual({ status: "ready", items: [{ id: "new" }] });
    expect(render(null).state.status).toBe("loading");
  });
});
