import { describe, expect, it } from "vitest";
import type { Connection, Item } from "@veil/core";
import { buildSocialGraph, ME_NODE_ID } from "./graph";
import {
  emptyGraphFilter,
  filterSocialGraph,
  isGraphFilterActive,
  normalizeGraphQuery,
  type GraphFilter,
} from "./graph-filters";

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

function fixture() {
  const alice = connection({ id: "alice", handle: "alice", nickname: "Al" });
  const bob = connection({ id: "bob", handle: "bobby" });
  const mine = item({ id: "m1", title: "Bridge at dawn" });
  const alices = item({ id: "c1", title: "Tomato ladder", authorId: "alice", authorHandle: "alice" });
  const bobs = item({
    id: "c2",
    type: "listing",
    title: "Milk crate shelves",
    authorId: "bob",
    authorHandle: "bobby",
    likedBy: ["alice"],
  });
  const graph = buildSocialGraph({
    myHandle: "me",
    connections: [alice, bob],
    items: [mine, alices, bobs],
  });
  return { graph, alice, bob, mine, alices, bobs };
}

const filter = (overrides: Partial<GraphFilter> = {}): GraphFilter => ({
  ...emptyGraphFilter,
  kinds: { ...emptyGraphFilter.kinds, ...overrides.kinds },
  ...overrides,
});

describe("normalizeGraphQuery / isGraphFilterActive", () => {
  it("trims and lowercases queries; whitespace-only is inactive", () => {
    expect(normalizeGraphQuery("  Bridge ")).toBe("bridge");
    expect(isGraphFilterActive(filter())).toBe(false);
    expect(isGraphFilterActive(filter({ query: "   " }))).toBe(false);
    expect(isGraphFilterActive(filter({ query: "x" }))).toBe(true);
    expect(isGraphFilterActive(filter({ kinds: { ...emptyGraphFilter.kinds, post: false } }))).toBe(true);
  });
});

describe("filterSocialGraph", () => {
  it("returns the input graph untouched when the filter is inactive", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(graph, filter());
    expect(result.graph).toBe(graph);
    expect(result.matchedNodes).toBe(0);
    expect(result.totalNodes).toBe(graph.nodes.length);
  });

  it("kind toggles remove those nodes and every edge touching them", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(graph, filter({ kinds: { connection: true, post: false, listing: true } }));
    const kinds = result.graph.nodes.map((node) => node.kind).sort();
    expect(kinds).toEqual(["connection", "connection", "listing", "me"]);
    // No authors edge may point at a removed post; the listing and its like stay.
    expect(result.graph.edges.some((edge) => edge.kind === "authors" && edge.target === "item:m1")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "authors" && edge.target === "item:c1")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "likes" && edge.target === "item:c2")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "connected")).toBe(true);
  });

  it("toggling off connections removes their items too, because the author edge is gone", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(graph, filter({ kinds: { connection: false, post: true, listing: true } }));
    // Only me and my own post survive: connection nodes are removed, and both-endpoint
    // edge filtering removes authorship edges, leaving their items isolated - so they
    // drop out with the kind toggle of their author.
    expect(result.graph.nodes.map((node) => node.id).sort()).toEqual(["item:m1", ME_NODE_ID].sort());
    // My own post keeps its authorship edge from me.
    expect(result.graph.edges.map((edge) => edge.id)).toEqual(["authors:m1"]);
  });

  it("search keeps matches and their direct neighbours only", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(graph, filter({ query: "bridge" }));
    // "Bridge at dawn" matches; its author (me) is the neighbour. No other nodes.
    expect(result.matchedNodes).toBe(1);
    expect(result.graph.nodes.map((node) => node.id).sort()).toEqual(["item:m1", ME_NODE_ID].sort());
    expect(result.graph.edges.map((edge) => edge.kind)).toEqual(["authors"]);
  });

  it("search is case-insensitive and matches nicknames", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(graph, filter({ query: "AL" }));
    // Matches Al (nickname). Her post and bob's listing (which she liked) are her
    // neighbours; bob himself is not.
    expect(result.matchedNodes).toBe(1);
    const ids = result.graph.nodes.map((node) => node.id).sort();
    expect(ids).toEqual([ME_NODE_ID, "connection:alice", "item:c1", "item:c2"].sort());
  });

  it("search never matches a node whose kind is toggled off", () => {
    const { graph } = fixture();
    const result = filterSocialGraph(
      graph,
      filter({ query: "bridge", kinds: { connection: true, post: false, listing: true } }),
    );
    expect(result.matchedNodes).toBe(0);
    expect(result.graph.nodes.map((node) => node.id)).toEqual([ME_NODE_ID]);
    expect(result.graph.edges).toEqual([]);
  });

  it("keeps only both-endpoint edges when a neighbour is kind-filtered out", () => {
    const { graph } = fixture();
    // Query matches bob's listing; its like edge to alice survives only if alice is shown.
    const withAlice = filterSocialGraph(graph, filter({ query: "milk" }));
    expect(withAlice.graph.edges.some((edge) => edge.kind === "likes")).toBe(true);
    const noConnections = filterSocialGraph(
      graph,
      filter({ query: "milk", kinds: { connection: false, post: true, listing: true } }),
    );
    // With every neighbour kind-filtered out, the matched listing would float
    // unattributed, so it drops out and counts as no shown match.
    expect(noConnections.graph.nodes.map((node) => node.id).sort()).toEqual([ME_NODE_ID]);
    expect(noConnections.graph.edges).toEqual([]);
    expect(noConnections.matchedNodes).toBe(0);
  });

  it("a hidden connection can never resurface through search, because they were never in the graph", () => {
    const alice = connection({ id: "alice", handle: "alice", hidden: true });
    const theirs = item({ id: "c1", title: "alice's tomatoes", authorId: "alice", authorHandle: "alice" });
    const graph = buildSocialGraph({ myHandle: "me", connections: [alice], items: [theirs] });
    expect(graph.nodes).toHaveLength(1); // me only; hidden alice excluded upstream
    const result = filterSocialGraph(graph, filter({ query: "alice" }));
    expect(result.matchedNodes).toBe(0);
    expect(result.graph.nodes.map((node) => node.id)).toEqual([ME_NODE_ID]);
  });

  it("carries truncation and hidden counts through for honest footer copy", () => {
    const alice = connection({ id: "alice", handle: "alice" });
    const hidden = connection({ id: "h", handle: "h", hidden: true });
    const items = Array.from({ length: 110 }, (_, i) =>
      item({ id: `m${i}`, createdAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}Z` }),
    );
    const graph = buildSocialGraph({ myHandle: "me", connections: [alice, hidden], items });
    expect(graph.truncatedItems).toBeGreaterThan(0);
    expect(graph.hiddenConnections).toBe(1);
    const result = filterSocialGraph(graph, filter({ query: "no-such-title" }));
    expect(result.graph.truncatedItems).toBe(graph.truncatedItems);
    expect(result.graph.hiddenConnections).toBe(1);
    expect(result.totalNodes).toBe(graph.nodes.length);
  });
});
