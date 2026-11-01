import { describe, expect, it } from "vitest";
import type { Connection, Item } from "@veil/core";
import { buildSocialGraph,
  graphBodyState, MAX_GRAPH_ITEMS, ME_NODE_ID } from "./graph";

let n = 0;
const nextId = () => `t${n++}`;

function connection(overrides: Partial<Connection> = {}): Connection {
  const id = overrides.id ?? nextId();
  return {
    id,
    handle: `handle-${id}`,
    addedAt: "2026-10-01T00:00:00Z",
    nickname: null,
    hidden: false,
    lastImportAt: null,
    pubkey: null,
    feedUrl: null,
    syncSeq: 0,
    syncEtag: null,
    syncPending: false,
    syncRetry: 0,
    syncExhausted: false,
    syncStatus: "",
    syncDetail: "",
    schemaVersion: 1,
    ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  const id = overrides.id ?? nextId();
  return {
    id,
    type: "photo",
    title: `Post ${id}`,
    category: "general",
    priceCents: null,
    description: "",
    createdAt: "2026-10-31T00:00:00Z",
    likes: 0,
    mediaIds: [],
    thumbId: null,
    mediaMime: "image/webp",
    visibility: "private",
    authorId: null,
    authorHandle: null,
    likedByMe: false,
    likedBy: [],
    schemaVersion: 1,
    ...overrides,
  };
}

describe("buildSocialGraph", () => {
  it("maps me, connections, and their items with authorship and like edges only", () => {
    const alice = connection({ id: "alice", handle: "alice" });
    const mine = item({ id: "m1" });
    const theirs = item({ id: "c1", authorId: "alice", authorHandle: "alice", likedByMe: true });
    const graph = buildSocialGraph({ myHandle: "adam", connections: [alice], items: [mine, theirs] });

    expect(graph.nodes.map((node) => node.id)).toEqual([ME_NODE_ID, "connection:alice", "item:c1", "item:m1"]);
    expect(graph.nodes.find((node) => node.id === ME_NODE_ID)?.label).toBe("adam");
    expect(graph.edges).toEqual([
      { id: "connected:alice", source: ME_NODE_ID, target: "connection:alice", kind: "connected" },
      { id: "authors:c1", source: "connection:alice", target: "item:c1", kind: "authors" },
      { id: "likes:me:c1", source: ME_NODE_ID, target: "item:c1", kind: "likes" },
      { id: "authors:m1", source: ME_NODE_ID, target: "item:m1", kind: "authors" },
    ]);
    expect(graph.hiddenConnections).toBe(0);
    expect(graph.truncatedItems).toBe(0);
  });

  it("labels listings as listings and prefers nicknames for connection labels", () => {
    const bob = connection({ id: "bob", handle: "b0b", nickname: "Bobby" });
    const listing = item({ id: "l1", type: "listing", authorId: "bob" });
    const graph = buildSocialGraph({ myHandle: null, connections: [bob], items: [listing] });
    expect(graph.nodes.find((node) => node.id === "connection:bob")?.label).toBe("Bobby");
    expect(graph.nodes.find((node) => node.id === "item:l1")?.kind).toBe("listing");
    expect(graph.nodes.find((node) => node.id === ME_NODE_ID)?.label).toBe("You");
  });

  it("excludes a hidden connection completely: node, authored items, and like edges", () => {
    const alice = connection({ id: "alice" });
    const ghost = connection({ id: "ghost", hidden: true });
    const ghostPost = item({ id: "g1", authorId: "ghost" });
    const alicePost = item({ id: "a1", authorId: "alice", likedBy: ["ghost"] });
    const myPost = item({ id: "m1", likedBy: ["ghost", "alice"] });
    const graph = buildSocialGraph({
      myHandle: null,
      connections: [alice, ghost],
      items: [ghostPost, alicePost, myPost],
    });

    const ids = graph.nodes.map((node) => node.id);
    expect(ids).not.toContain("connection:ghost");
    expect(ids).not.toContain("item:g1");
    // No edge anywhere names the hidden connection, even as a liker.
    expect(graph.edges.some((edge) => edge.id.includes("ghost") || edge.source.includes("ghost"))).toBe(false);
    expect(graph.edges).toContainEqual({ id: "likes:alice:m1", source: "connection:alice", target: "item:m1", kind: "likes" });
    expect(graph.hiddenConnections).toBe(1);
  });

  it("drops items whose author is no longer a connection instead of inventing an edge", () => {
    const orphan = item({ id: "o1", authorId: "removed-person" });
    const graph = buildSocialGraph({ myHandle: null, connections: [], items: [orphan] });
    expect(graph.nodes.map((node) => node.id)).toEqual([ME_NODE_ID]);
    expect(graph.edges).toEqual([]);
  });

  it("caps item nodes and reports the truncation", () => {
    const items = Array.from({ length: MAX_GRAPH_ITEMS + 5 }, (_, i) =>
      item({ id: `p${i}`, createdAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const graph = buildSocialGraph({ myHandle: null, connections: [], items });
    expect(graph.nodes.filter((node) => node.kind === "post")).toHaveLength(MAX_GRAPH_ITEMS);
    expect(graph.truncatedItems).toBe(5);
  });

  it("is deterministic for the same input", () => {
    const connections = [connection({ id: "b" }), connection({ id: "a" })];
    const items = [item({ id: "2" }), item({ id: "1" })];
    const first = buildSocialGraph({ myHandle: null, connections, items });
    const second = buildSocialGraph({ myHandle: null, connections, items });
    expect(first).toEqual(second);
  });
});

describe("createGraphLayout", () => {
  // Late import to keep the builder tests above focused.
  const makeGraph = () =>
    buildSocialGraph({
      myHandle: "adam",
      connections: [connection({ id: "a" }), connection({ id: "b" })],
      items: [item({ id: "i1", authorId: "a" }), item({ id: "i2", likedBy: ["a"] })],
    });

  it("settles to finite, in-frame, non-overlapping positions", async () => {
    const { createGraphLayout, GRAPH_RADIUS } = await import("./graph");
    const layout = createGraphLayout(makeGraph(), { width: 640, height: 420, preset: "radial", spread: 1 });
    for (let i = 0; i < 400; i += 1) layout.tick();
    expect(layout.settled()).toBe(true);
    const positions = layout.positions();
    const all = Object.values(positions);
    expect(all).toHaveLength(5); // me + 2 connections + 2 items
    for (const { x, y } of all) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Math.abs(x - 320)).toBeLessThanOrEqual(320);
      expect(Math.abs(y - 210)).toBeLessThanOrEqual(210);
    }
    // No two shapes overlap after settling.
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const distance = Math.hypot(all[i]!.x - all[j]!.x, all[i]!.y - all[j]!.y);
        expect(distance).toBeGreaterThan(GRAPH_RADIUS.me / 2);
      }
    }
  });

  it("keeps the me node near center on the radial preset and honors pins", async () => {
    const { createGraphLayout, ME_NODE_ID: meId } = await import("./graph");
    const layout = createGraphLayout(makeGraph(), {
      width: 640,
      height: 420,
      preset: "radial",
      spread: 1,
      pins: { "connection:a": { x: 10, y: 10 } },
    });
    for (let i = 0; i < 400; i += 1) layout.tick();
    const positions = layout.positions();
    expect(positions["connection:a"]).toEqual({ x: 10, y: 10 });
    expect(Math.hypot(positions[meId]!.x - 320, positions[meId]!.y - 210)).toBeLessThan(30);
  });

  it("moves a dragged pin live and reheats", async () => {
    const { createGraphLayout } = await import("./graph");
    const layout = createGraphLayout(makeGraph(), { width: 640, height: 420, preset: "free", spread: 1 });
    layout.movePin("item:i2", { x: 100, y: 100 });
    expect(layout.positions()["item:i2"]).toEqual({ x: 100, y: 100 });
    for (let i = 0; i < 400; i += 1) layout.tick();
    expect(layout.settled()).toBe(true);
    const settledPositions = layout.positions();
    layout.reheat(0.5);
    expect(layout.settled()).toBe(false);
    expect(layout.positions()["item:i2"]).toEqual({ x: 100, y: 100 });
    layout.tick();
    expect(layout.positions()[ME_NODE_ID]).not.toEqual(settledPositions[ME_NODE_ID]);
  });

  it("is deterministic for identical inputs", async () => {
    const { createGraphLayout } = await import("./graph");
    const run = () => {
      const layout = createGraphLayout(makeGraph(), { width: 640, height: 420, preset: "radial", spread: 1 });
      for (let i = 0; i < 400; i += 1) layout.tick();
      return layout.positions();
    };
    expect(run()).toEqual(run());
  });
});

describe("graphBodyState", () => {
  it("never calls loading or error an empty map", () => {
    expect(graphBodyState("loading", 1)).toBe("loading");
    expect(graphBodyState("loading", 0)).toBe("loading");
    expect(graphBodyState("error", 1)).toBe("error");
    expect(graphBodyState("error", 5)).toBe("error");
  });

  it("ready with only the you node is empty; anything more is content", () => {
    expect(graphBodyState("ready", 1)).toBe("empty");
    expect(graphBodyState("ready", 2)).toBe("content");
    expect(graphBodyState("ready", 40)).toBe("content");
  });
});

describe("resolveGraphFocus", () => {
  it("maps a visible connection id to its node and never resolves a hidden or unknown one", async () => {
    const { resolveGraphFocus } = await import("./graph");
    const graph = buildSocialGraph({
      myHandle: "me",
      connections: [connection({ id: "alice" }), connection({ id: "ghost", hidden: true })],
      items: [],
    });
    expect(resolveGraphFocus(graph, "alice")).toBe("connection:alice");
    expect(resolveGraphFocus(graph, "ghost")).toBeNull();
    expect(resolveGraphFocus(graph, "nobody")).toBeNull();
    expect(resolveGraphFocus(graph, null)).toBeNull();
    expect(resolveGraphFocus(graph, "")).toBeNull();
  });
});
