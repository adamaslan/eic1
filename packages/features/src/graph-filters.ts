import type { GraphEdge, GraphNode, GraphNodeKind, SocialGraph } from "./graph";
import { ME_NODE_ID } from "./graph";

/**
 * Social graph filters: kind toggles and a label search that narrow the already-built
 * graph. A filter only ever removes nodes - an edge survives only when both endpoints do,
 * so filtering can never reintroduce a hidden connection or invent a relationship. The
 * "you" node always stays, so the map keeps its anchor.
 *
 * A text search keeps matching nodes and their direct neighbours (so a match still shows
 * who authored or liked it); everything else drops out. Kind toggles apply first, so a
 * search never matches something the reader toggled off.
 */

export type FilterableGraphKind = Exclude<GraphNodeKind, "me">;

export interface GraphFilter {
  /** Case-insensitive substring matched against node labels. Empty means no text filter. */
  query: string;
  /** Which node kinds to show. "me" is not listed: it is always shown. */
  kinds: Record<FilterableGraphKind, boolean>;
}

export const emptyGraphFilter: GraphFilter = {
  query: "",
  kinds: { connection: true, post: true, listing: true },
};

export function normalizeGraphQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function isGraphFilterActive(filter: GraphFilter): boolean {
  return (
    normalizeGraphQuery(filter.query) !== "" ||
    !filter.kinds.connection ||
    !filter.kinds.post ||
    !filter.kinds.listing
  );
}

export interface FilteredGraph {
  graph: SocialGraph;
  /** Nodes whose label matches the query (0 when no query is set). */
  matchedNodes: number;
  /** Total nodes in the unfiltered graph, for "X of Y" copy. */
  totalNodes: number;
}

export function filterSocialGraph(graph: SocialGraph, filter: GraphFilter): FilteredGraph {
  const query = normalizeGraphQuery(filter.query);
  const kindAllowed = (node: GraphNode) => node.kind === "me" || filter.kinds[node.kind];

  if (query === "" && filter.kinds.connection && filter.kinds.post && filter.kinds.listing) {
    return { graph, matchedNodes: 0, totalNodes: graph.nodes.length };
  }

  const kindKept = new Set(graph.nodes.filter(kindAllowed).map((node) => node.id));
  const queryMatches = new Set(
    query === ""
      ? []
      : graph.nodes
          .filter((node) => kindKept.has(node.id) && node.label.toLowerCase().includes(query))
          .map((node) => node.id),
  );

  let kept: Set<string>;
  if (query === "") {
    kept = kindKept;
  } else {
    kept = new Set(queryMatches);
    kept.add(ME_NODE_ID);
    for (const edge of graph.edges) {
      if (queryMatches.has(edge.source) && kindKept.has(edge.target)) kept.add(edge.target);
      if (queryMatches.has(edge.target) && kindKept.has(edge.source)) kept.add(edge.source);
    }
  }

  let keptIds = kept;
  let edges = graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  // The base graph only shows items whose author is in the map; filtering must keep that
  // invariant. An item left with no surviving edge (its author or likers were filtered
  // out) would float unattributed, so it drops out too.
  const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  keptIds = new Set([...keptIds].filter((id) => id === ME_NODE_ID || linked.has(id)));
  const nodes = graph.nodes.filter((node) => keptIds.has(node.id));
  edges = edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));
  return {
    graph: { nodes, edges, truncatedItems: graph.truncatedItems, hiddenConnections: graph.hiddenConnections },
    // Only matches that actually survive: a match left with no surviving edge drops out
    // like any unattributed item, so it does not count as shown.
    matchedNodes: [...queryMatches].filter((id) => keptIds.has(id)).length,
    totalNodes: graph.nodes.length,
  };
}
