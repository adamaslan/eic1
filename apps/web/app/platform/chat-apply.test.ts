import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@veil/features";
import {
  applyCatchUpOutcome,
  createThreadReload,
  handleLockLost,
  listenForApplied,
  withCatchUpLock,
  type AppliedChannel,
} from "./chat-apply";

const message = (id: string): ChatMessage => ({
  v: 1,
  id,
  threadAuthorId: "author-a",
  direction: "in",
  body: `body ${id}`,
  sentAt: "2026-11-13T20:00:00.000Z",
  readAt: null,
  envelope: null,
  envelopeSignature: null,
});

const fakeChannel = (): AppliedChannel & { listeners: Set<(event: { data: unknown }) => void> } => {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    listeners,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    postMessage: (data) => { for (const listener of [...listeners]) listener({ data }); },
  };
};

describe("createThreadReload", () => {
  it("paints the thread when the route is unchanged", async () => {
    const applied: ChatMessage[][] = [];
    const reload = createThreadReload({
      markRead: vi.fn().mockResolvedValue(undefined),
      loadThread: vi.fn().mockResolvedValue([message("m1")]),
      applyThread: (thread) => applied.push(thread),
      currentAuthorId: () => "author-a",
    });
    await reload("author-a");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.map((m) => m.id)).toEqual(["m1"]);
  });

  it("never paints chat A's thread after the route moved to chat B mid-reload", async () => {
    let current: string | null = "author-a";
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const applyThread = vi.fn();
    const reload = createThreadReload({
      markRead: () => gate,
      loadThread: vi.fn().mockResolvedValue([message("m1")]),
      applyThread,
      currentAuthorId: () => current,
    });
    const pending = reload("author-a");
    current = "author-b"; // the user opened chat B while A's reload was awaited
    release();
    await pending;
    expect(applyThread).not.toHaveBeenCalled();
  });

  it("never paints when the load itself outlives the route change", async () => {
    let current: string | null = "author-a";
    let release!: (thread: ChatMessage[]) => void;
    const gate = new Promise<ChatMessage[]>((done) => { release = done; });
    const applyThread = vi.fn();
    const reload = createThreadReload({
      markRead: vi.fn().mockResolvedValue(undefined),
      loadThread: () => gate,
      applyThread,
      currentAuthorId: () => current,
    });
    const pending = reload("author-a");
    current = "author-b";
    release([message("m1")]);
    await pending;
    expect(applyThread).not.toHaveBeenCalled();
  });

  it("same-author overlap: only the latest request paints, even when it resolves first", async () => {
    let releaseOld!: (thread: ChatMessage[]) => void;
    const slowGate = new Promise<ChatMessage[]>((done) => { releaseOld = done; });
    const applied: ChatMessage[][] = [];
    const loadThread = vi
      .fn()
      .mockImplementationOnce(() => slowGate)
      .mockResolvedValue([message("m-new")]);
    const reload = createThreadReload({
      markRead: vi.fn().mockResolvedValue(undefined),
      loadThread,
      applyThread: (thread) => applied.push(thread),
      currentAuthorId: () => "author-a",
    });
    const older = reload("author-a"); // e.g. the mount load, still awaiting its read
    await reload("author-a"); // e.g. the broadcast-triggered reload, resolves first
    releaseOld([message("m-old")]);
    await older;
    // The older snapshot resolves LAST but must not paint over the newer one.
    expect(applied.map((t) => t.map((m) => m.id))).toEqual([["m-new"]]);
  });

  it("A -> B -> A: the first A reload outliving the second A reload must not paint", async () => {
    let current: string | null = "author-a";
    let releaseFirst!: (thread: ChatMessage[]) => void;
    const slowGate = new Promise<ChatMessage[]>((done) => { releaseFirst = done; });
    const applied: ChatMessage[][] = [];
    const loadThread = vi
      .fn()
      .mockImplementationOnce(() => slowGate)
      .mockResolvedValue([message("m-latest")]);
    const reload = createThreadReload({
      markRead: vi.fn().mockResolvedValue(undefined),
      loadThread,
      applyThread: (thread) => applied.push(thread),
      currentAuthorId: () => current,
    });
    const firstA = reload("author-a");
    current = "author-b";
    await reload("author-b"); // B's paint is B's business; guarded by currentAuthorId
    current = "author-a";
    await reload("author-a"); // the second A load paints the latest thread
    releaseFirst([message("m-stale")]);
    await firstA;
    expect(applied.map((t) => t.map((m) => m.id))).toEqual([["m-latest"], ["m-latest"]]);
  });
});

describe("applyCatchUpOutcome", () => {
  const harness = (over: Partial<Parameters<typeof applyCatchUpOutcome>[1]> = {}) => {
    const calls: string[] = [];
    const deps = {
      active: () => true,
      reload: vi.fn(async () => { calls.push("reload"); }),
      onApplied: vi.fn(() => { calls.push("applied"); }),
      onSkipped: vi.fn(() => { calls.push("skipped"); }),
      onDeferred: vi.fn(() => { calls.push("deferred"); }),
      onReceived: vi.fn(() => { calls.push("received"); }),
      onUnchanged: vi.fn(() => { calls.push("unchanged"); }),
      ...over,
    };
    return { calls, deps };
  };

  it("refreshes applied messages BEFORE the partial branch returns", async () => {
    const { calls, deps } = harness();
    await applyCatchUpOutcome({ status: "partial", appliedChat: 2 }, deps);
    expect(calls).toEqual(["applied", "reload", "skipped"]);
  });

  it("refreshes applied messages BEFORE the deferred branch returns", async () => {
    const { calls, deps } = harness();
    await applyCatchUpOutcome({ status: "deferred", appliedChat: 1 }, deps);
    expect(calls).toEqual(["applied", "reload", "deferred"]);
  });

  it("reports a plain receive after refreshing", async () => {
    const { calls, deps } = harness();
    await applyCatchUpOutcome({ status: "applied", appliedChat: 3 }, deps);
    expect(calls).toEqual(["applied", "reload", "received"]);
  });

  it("clears auto-owned state on an unchanged success without reloading", async () => {
    const { calls, deps } = harness();
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(calls).toEqual(["unchanged"]);
  });

  it("throws on failure so the scheduler backs off", async () => {
    const { deps } = harness();
    await expect(applyCatchUpOutcome({ status: "failed", appliedChat: 0 }, deps)).rejects.toThrow("unavailable");
  });

  it("sets no notice when the route died during the reload", async () => {
    let alive = true;
    const calls: string[] = [];
    const deps = {
      active: () => alive,
      reload: vi.fn(async () => { calls.push("reload"); alive = false; }),
      onApplied: vi.fn(() => { calls.push("applied"); }),
      onSkipped: vi.fn(() => { calls.push("skipped"); }),
      onDeferred: vi.fn(() => { calls.push("deferred"); }),
      onReceived: vi.fn(() => { calls.push("received"); }),
      onUnchanged: vi.fn(() => { calls.push("unchanged"); }),
    };
    await applyCatchUpOutcome({ status: "applied", appliedChat: 1 }, deps);
    expect(calls).toEqual(["applied", "reload"]);
  });

  it("hidden mid-catch-up: committed writes are still announced and the refresh debt is retained", async () => {
    const contention = { dirty: false };
    const deps = {
      active: () => false, // the tab went hidden while its pass was applying
      reload: vi.fn().mockResolvedValue(undefined),
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(), onUnchanged: vi.fn(),
      contention,
    };
    await applyCatchUpOutcome({ status: "applied", appliedChat: 2 }, deps);
    // Other tabs still learn about the committed writes; this tab owes itself a refresh.
    expect(deps.onApplied).toHaveBeenCalledWith(2);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.onReceived).not.toHaveBeenCalled();
    expect(contention.dirty).toBe(true);

    // On refocus the next poll reads unchanged (the cursor already advanced): the
    // retained flag must drive the reload a clean flag would have skipped.
    deps.active = () => true;
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(contention.dirty).toBe(false);
    expect(deps.onUnchanged).toHaveBeenCalled();
  });

  it("hidden with nothing applied: no announcement, no debt, no notice", async () => {
    const contention = { dirty: false };
    const deps = {
      active: () => false,
      reload: vi.fn(),
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(), onUnchanged: vi.fn(),
      contention,
    };
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(deps.onApplied).not.toHaveBeenCalled();
    expect(contention.dirty).toBe(false);
  });
});

describe("withCatchUpLock + handleLockLost", () => {
  const denyingLocks = () => ({
    request: vi.fn(async (_name: string, _options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => callback(null)),
  });
  const grantingLocks = () => ({
    request: vi.fn(async (_name: string, _options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => callback({})),
  });
  // First (ifAvailable) request is denied; a queued request waits until release() or abort.
  const queueableLocks = () => {
    let release!: () => void;
    const winner = new Promise<void>((done) => { release = done; });
    const locks = {
      request: vi.fn(async (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => {
        if (options.ifAvailable) { await callback(null); return; }
        await new Promise<void>((done, reject) => {
          winner.then(() => done());
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        await callback({});
      }),
    };
    return { locks, release: () => release() };
  };

  it("runs the pass when the lock is held", async () => {
    const pass = vi.fn().mockResolvedValue(undefined);
    await withCatchUpLock(grantingLocks(), "lock", { pass, onLockLost: vi.fn() });
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("runs the pass directly when Web Locks are missing", async () => {
    const pass = vi.fn().mockResolvedValue(undefined);
    await withCatchUpLock(null, "lock", { pass, onLockLost: vi.fn() });
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("lock loser with a broadcast channel does NOT reload immediately (winner may not have written yet)", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const pass = vi.fn();
    const locks = denyingLocks();
    await withCatchUpLock(locks, "lock", {
      pass,
      onLockLost: () => handleLockLost(fakeChannel(), locks, "lock", () => true, reload),
    });
    expect(pass).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("no channel: the loser queues on the SAME lock and reloads once the winner releases - a refresh, not another pass", async () => {
    const { locks, release } = queueableLocks();
    const reload = vi.fn().mockResolvedValue(undefined);
    const pass = vi.fn();
    const pending = withCatchUpLock(locks, "lock", {
      pass,
      onLockLost: () => handleLockLost(null, locks, "lock", () => true, reload),
    });
    await Promise.resolve();
    await Promise.resolve();
    // The winner is still mid-pass: nothing may refresh yet.
    expect(reload).not.toHaveBeenCalled();
    release();
    await pending;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(pass).not.toHaveBeenCalled();
  });

  it("no channel: the queued wait is bounded - an abort leaves refresh to the next trigger", async () => {
    vi.useFakeTimers();
    try {
      const locks = {
        request: vi.fn(async (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => {
          if (options.ifAvailable) { await callback(null); return; }
          await new Promise((_done, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
      };
      const reload = vi.fn().mockResolvedValue(undefined);
      const pending = withCatchUpLock(locks, "lock", {
        pass: vi.fn(),
        onLockLost: () => handleLockLost(null, locks, "lock", () => true, reload),
      });
      await vi.advanceTimersByTimeAsync(6000);
      await pending;
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delayed winner: the loser refreshes when the winner's applied broadcast lands, even ticks later", async () => {
    const channel = fakeChannel();
    const reload = vi.fn().mockResolvedValue(undefined);
    const locks = denyingLocks();
    // Loser tick: lock denied, no immediate reload, listener registered.
    await withCatchUpLock(locks, "lock", {
      pass: vi.fn(),
      onLockLost: () => handleLockLost(channel, locks, "lock", () => true, reload),
    });
    const unlisten = listenForApplied(channel, "conn-1", () => { void reload(); });
    expect(reload).not.toHaveBeenCalled();
    // The winner finishes its pass later and announces committed writes.
    channel.postMessage({ connectionId: "conn-1" });
    expect(reload).toHaveBeenCalledTimes(1);
    // A later denied tick still does not reload on its own - the cursor reads unchanged.
    await withCatchUpLock(locks, "lock", {
      pass: vi.fn(),
      onLockLost: () => handleLockLost(channel, locks, "lock", () => true, reload),
    });
    expect(reload).toHaveBeenCalledTimes(1);
    // Broadcasts for other connections are ignored.
    channel.postMessage({ connectionId: "conn-2" });
    expect(reload).toHaveBeenCalledTimes(1);
    channel.postMessage(null);
    channel.postMessage("conn-1");
    expect(reload).toHaveBeenCalledTimes(1);
    unlisten();
    channel.postMessage({ connectionId: "conn-1" });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("contention flag: the abort band cannot go durably stale", () => {
  const outcomeDeps = (contention: { dirty: boolean }) => {
    const calls: string[] = [];
    return { calls, deps: {
      active: () => true,
      reload: vi.fn(async () => { calls.push("reload"); }),
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(),
      onUnchanged: vi.fn(() => { calls.push("unchanged"); }),
      contention,
    } };
  };

  it("an unchanged outcome after lost contention reloads once and clears the flag", async () => {
    const contention = { dirty: true };
    const { calls, deps } = outcomeDeps(contention);
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(calls).toEqual(["reload", "unchanged"]);
    expect(contention.dirty).toBe(false);
    // Clean now: a later unchanged poll does not reload again.
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(calls).toEqual(["reload", "unchanged", "unchanged"]);
  });

  it("applied outcomes clear the flag too (their reload already pulled the writes)", async () => {
    const contention = { dirty: true };
    const { deps } = outcomeDeps(contention);
    await applyCatchUpOutcome({ status: "applied", appliedChat: 1 }, deps);
    expect(contention.dirty).toBe(false);
  });

  it(">5s winner: abort leaves the flag dirty, the next acquired unchanged pass reloads", async () => {
    vi.useFakeTimers();
    try {
      let winnerDone = false;
      const locks = {
        request: vi.fn(async (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => {
          if (options.ifAvailable) { await callback(winnerDone ? {} : null); return; }
          // Queued acquisition: resolves only when the winner finishes (never, here) or on abort.
          await new Promise((_done, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
      };
      const contention = { dirty: false };
      const reload = vi.fn().mockResolvedValue(undefined);
      // Tick 1: lock contended, queued wait aborts after 5s while the winner still works.
      const tick1 = withCatchUpLock(locks, "lock", {
        pass: vi.fn(),
        onLockLost: () => handleLockLost(null, locks, "lock", () => true, reload, contention),
      });
      await vi.advanceTimersByTimeAsync(6000);
      await tick1;
      expect(reload).not.toHaveBeenCalled();
      expect(contention.dirty).toBe(true);
      // Winner finishes before the next tick; the loser now ACQUIRES and its pass reads unchanged.
      winnerDone = true;
      const pass = vi.fn(async () => {
        await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, {
          active: () => true,
          reload,
          onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
          onReceived: vi.fn(), onUnchanged: vi.fn(),
          contention,
        });
      });
      await withCatchUpLock(locks, "lock", { pass, onLockLost: vi.fn() });
      expect(pass).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(contention.dirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("contention flag hardening: only a completed refresh consumes", () => {
  it("unchanged consumption survives a throwing reload and retries next poll", async () => {
    const contention = { dirty: true };
    const calls: string[] = [];
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error("transient vault read failure"))
      .mockImplementation(async () => { calls.push("reload"); });
    const deps = {
      active: () => true,
      reload,
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(), onUnchanged: vi.fn(),
      contention,
    };
    // Failed reload: flag retained, no unhandled rejection, notice path still runs.
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(contention.dirty).toBe(true);
    expect(deps.onUnchanged).toHaveBeenCalledTimes(1);
    // Next unchanged poll retries and consumes on success.
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(calls).toEqual(["reload"]);
    expect(contention.dirty).toBe(false);
  });

  it("an applied outcome whose reload throws keeps the flag - but the committed writes are still announced", async () => {
    const contention = { dirty: true };
    const deps = {
      active: () => true,
      reload: vi.fn().mockRejectedValue(new Error("boom")),
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(), onUnchanged: vi.fn(),
      contention,
    };
    await expect(applyCatchUpOutcome({ status: "applied", appliedChat: 1 }, deps)).rejects.toThrow("boom");
    expect(contention.dirty).toBe(true);
    // The announcement belongs to other tabs; this tab's failed UI refresh must not eat it.
    expect(deps.onApplied).toHaveBeenCalledWith(1);
  });

  it("a throwing applied-branch reload on a CLEAN flag raises the debt, and the next unchanged poll recovers", async () => {
    // Committed writes + advanced cursor + clean flag + failed refresh = the durable
    // stale band again unless the failure itself sets the flag.
    const contention = { dirty: false };
    const deps = {
      active: () => true,
      reload: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined),
      onApplied: vi.fn(), onSkipped: vi.fn(), onDeferred: vi.fn(),
      onReceived: vi.fn(), onUnchanged: vi.fn(),
      contention,
    };
    await expect(applyCatchUpOutcome({ status: "applied", appliedChat: 1 }, deps)).rejects.toThrow("boom");
    expect(contention.dirty).toBe(true);
    expect(deps.onApplied).toHaveBeenCalledWith(1);
    // The next unchanged poll performs the refresh a clean flag would have skipped.
    await applyCatchUpOutcome({ status: "unchanged", appliedChat: 0 }, deps);
    expect(deps.reload).toHaveBeenCalledTimes(2);
    expect(contention.dirty).toBe(false);
    expect(deps.onUnchanged).toHaveBeenCalled();
  });

  it("queued grant without an active screen does not consume the flag", async () => {
    let release!: () => void;
    const winner = new Promise<void>((done) => { release = done; });
    const locks = {
      request: vi.fn(async (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (held: unknown) => Promise<void>) => {
        if (options.ifAvailable) { await callback(null); return; }
        await winner;
        await callback({});
      }),
    };
    const contention = { dirty: false };
    const reload = vi.fn().mockResolvedValue(undefined);
    const pending = withCatchUpLock(locks, "lock", {
      pass: vi.fn(),
      onLockLost: () => handleLockLost(null, locks, "lock", () => false, reload, contention),
    });
    expect(contention.dirty).toBe(true);
    release!();
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(contention.dirty).toBe(true);
  });
});
