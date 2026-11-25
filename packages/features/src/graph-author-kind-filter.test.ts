import { describe, expect, it } from "vitest";
import type { Connection, Item } from "@veil/core";
import { buildSocialGraph, ME_NODE_ID } from "./graph";
import { filterSocialGraph } from "./graph-filters";

const alice = { id: "alice", handle: "alice", nickname: null, hidden: false } as Connection;
const post = (id: string, authorId: string | null, type: Item["type"] = "photo"): Item => ({
  id, type, title: `bridge ${id}`, createdAt: "2026-11-24T12:00:00Z", authorId,
  authorHandle: authorId, likedByMe: true, likedBy: [],
} as unknown as Item);

for (const type of ["photo", "listing"] as const) {
  for (const query of ["", "bridge"]) {
    it(`Connections off excludes a liked remote ${type} with query ${JSON.stringify(query)}`, () => {
      const graph = buildSocialGraph({ myHandle: "me", connections: [alice],
        items: [post("mine", null, type), post("theirs", "alice", type)] });
      const before = structuredClone(graph);
      const result = filterSocialGraph(graph, { query, kinds: { connection: false, post: true, listing: true } });
      expect(result.graph.nodes.map(node => node.id)).toEqual([ME_NODE_ID, "item:mine"]);
      expect(result.graph.edges.some(edge => edge.target === "item:theirs")).toBe(false);
      expect(result.matchedNodes).toBe(query ? 1 : 0);
      expect(graph).toEqual(before);
    });
  }
}

describe("preserved graph relationships", () => {
  const graph = buildSocialGraph({ myHandle: "me", connections: [alice], items: [post("theirs", "alice")] });
  it("retains the remote item and both authorship and like when Connections stays enabled", () => {
    const result = filterSocialGraph(graph, { query: "bridge", kinds: { connection: true, post: true, listing: true } });
    expect(result.graph.nodes.map(node => node.id)).toContain("item:theirs");
    expect(result.graph.edges.filter(edge => edge.target === "item:theirs").map(edge => edge.kind).sort()).toEqual(["authors", "likes"]);
  });
});
