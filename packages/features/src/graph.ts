import type { Connection, Item } from "@veil/core";

/**
 * Social graph model: you, your connections, and the feed posts and market listings in
 * this vault, drawn as one map. Every edge traces to real vault data - authorship and
 * likes - and nothing is inferred beyond it. A connection you hid stays out of the graph
 * completely: their node, everything they authored, and every like edge that would name
 * them are all excluded, so hiding never leaks back through another edge.
 *
 * This is a local view of local data. Private posts appear only as your own nodes and
 * the graph changes nothing about what leaves the vault.
 */

export const MAX_GRAPH_ITEMS = 100;

export type GraphNodeKind = "me" | "connection" | "post" | "listing";
export type GraphEdgeKind = "connected" | "authors" | "likes";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Where clicking the node takes you. */
  href: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface SocialGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Items left out because the graph caps its node count. */
  truncatedItems: number;
  /** Hidden connections, excluded with everything they authored or liked. */
  hiddenConnections: number;
}

export const ME_NODE_ID = "me";
export const connectionNodeId = (connectionId: string) => `connection:${connectionId}`;
export const itemNodeId = (itemId: string) => `item:${itemId}`;

export function connectionDisplayName(connection: Pick<Connection, "handle" | "nickname">): string {
  return connection.nickname ?? connection.handle;
}

const LABEL_MAX = 28;
function shortLabel(title: string): string {
  return title.length > LABEL_MAX ? `${title.slice(0, LABEL_MAX - 1)}…` : title;
}

export function buildSocialGraph(input: {
  myHandle: string | null;
  connections: Connection[];
  items: Item[];
}): SocialGraph {
  const visible = input.connections.filter((connection) => !connection.hidden);
  const visibleIds = new Set(visible.map((connection) => connection.id));
  const hiddenConnections = input.connections.length - visible.length;

  const nodes: GraphNode[] = [
    { id: ME_NODE_ID, kind: "me", label: input.myHandle ?? "You", href: "/profile" },
  ];
  const edges: GraphEdge[] = [];

  for (const connection of [...visible].sort((a, b) => a.handle.localeCompare(b.handle))) {
    nodes.push({
      id: connectionNodeId(connection.id),
      kind: "connection",
      label: connectionDisplayName(connection),
      href: `/profile/${connection.id}`,
    });
    edges.push({
      id: `connected:${connection.id}`,
      source: ME_NODE_ID,
      target: connectionNodeId(connection.id),
      kind: "connected",
    });
  }

  // Only items whose author is in the graph: mine, or a visible connection's. A post from a
  // hidden or removed connection has no honest author node to hang from, so it stays out.
  const graphable = input.items
    .filter((item) => item.authorId === null || visibleIds.has(item.authorId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const shown = graphable.slice(0, MAX_GRAPH_ITEMS);

  for (const item of shown) {
    const nodeId = itemNodeId(item.id);
    nodes.push({
      id: nodeId,
      kind: item.type === "listing" ? "listing" : "post",
      label: shortLabel(item.title),
      href: `/item/${item.id}`,
    });
    const authorNode = item.authorId === null ? ME_NODE_ID : connectionNodeId(item.authorId);
    edges.push({ id: `authors:${item.id}`, source: authorNode, target: nodeId, kind: "authors" });
    if (item.likedByMe) {
      edges.push({ id: `likes:me:${item.id}`, source: ME_NODE_ID, target: nodeId, kind: "likes" });
    }
    for (const likerId of [...item.likedBy].sort()) {
      if (!visibleIds.has(likerId)) continue;
      edges.push({ id: `likes:${likerId}:${item.id}`, source: connectionNodeId(likerId), target: nodeId, kind: "likes" });
    }
  }

  return { nodes, edges, truncatedItems: graphable.length - shown.length, hiddenConnections };
}

/**
 * Dependency-free force layout for the social graph, following the placement logic of the
 * Ulysses graph app: tight hierarchy edges and loose statistical ones, hubs given room to
 * fan out, a spread factor that scales distances and repulsion, per-kind radial rings, and
 * pins that survive re-layouts. Runs synchronously in ticks so it is fully unit-testable;
 * the route animates by ticking per frame and settles instantly under reduced motion.
 */

export const GRAPH_SPREAD_MIN = 0.6;
export const GRAPH_SPREAD_MAX = 2.5;

export type GraphPreset = "radial" | "free";

const LINK_DISTANCE: Record<GraphEdgeKind, number> = { connected: 90, authors: 55, likes: 95 };
const CHARGE = -180;
const COLLIDE_PAD = 4;
const HUB_DISTANCE_PER_SQRT_DEGREE = 2;
const LABEL_CHAR_WIDTH = 5.5;
const LABEL_EXTRA_MAX = 30;

export const GRAPH_RING: Record<GraphNodeKind, number> = { me: 0, connection: 120, post: 215, listing: 215 };
export const GRAPH_RADIUS: Record<GraphNodeKind, number> = { me: 10, connection: 8, post: 5, listing: 6 };

const TICKS_TO_SETTLE = 300;
const ALPHA_MIN = 0.02;
const CENTER_PULL = 0.045;
const RADIAL_PULL = 0.7;
const LINK_STRENGTH = 0.05;
const REPULSION_CAP = 400;
const VELOCITY_DAMPING = 0.6;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphLayoutOptions {
  width: number;
  height: number;
  preset: GraphPreset;
  spread: number;
  /** Pinned node positions; pinned nodes are never moved by the simulation. */
  pins?: Record<string, GraphPoint>;
  /** Starting positions, e.g. from a previous layout so re-layouts settle gently. */
  start?: Record<string, GraphPoint>;
}

export interface GraphLayout {
  /** One simulation step. */
  tick: () => void;
  /** Current position of every node. */
  positions: () => Record<string, GraphPoint>;
  /** Pin or unpin a node. */
  setPin: (id: string, point: GraphPoint | null) => void;
  /** Move a pinned node (live drag). */
  movePin: (id: string, point: GraphPoint) => void;
  /** True once the layout has cooled. */
  settled: () => boolean;
  /** Reheat after a drag or spread change. */
  reheat: (alpha?: number) => void;
}

interface Body {
  id: string;
  kind: GraphNodeKind;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pin: GraphPoint | null;
  degree: number;
}

export function createGraphLayout(graph: SocialGraph, options: GraphLayoutOptions): GraphLayout {
  const { width, height, preset, pins = {}, start = {} } = options;
  const spread = Math.min(GRAPH_SPREAD_MAX, Math.max(GRAPH_SPREAD_MIN, options.spread));
  const cx = width / 2;
  const cy = height / 2;
  // Narrow (phone) canvases shrink the rings so nodes stay inside the frame.
  const ringScale = Math.min(1, Math.min(width, height) / 420);
  const ringOf = (kind: GraphNodeKind): number => GRAPH_RING[kind] * ringScale;

  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const bodies: Body[] = graph.nodes.map((node, index) => {
    const angle = (index / Math.max(1, graph.nodes.length - 1)) * Math.PI * 2;
    const ring = ringOf(node.kind);
    const seed = start[node.id] ?? { x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring };
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      x: seed.x,
      y: seed.y,
      vx: 0,
      vy: 0,
      pin: pins[node.id] ?? null,
      degree: degree.get(node.id) ?? 1,
    };
  });
  const byId = new Map(bodies.map((body) => [body.id, body]));

  const links = graph.edges
    .map((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return null;
      const hub = Math.max(source.degree, target.degree);
      return { source, target, distance: (LINK_DISTANCE[edge.kind] + Math.sqrt(hub) * HUB_DISTANCE_PER_SQRT_DEGREE) * spread };
    })
    .filter((link) => link !== null);

  const collideRadius = (body: Body): number => {
    const labelled = body.kind === "me" || body.kind === "connection";
    const labelExtra = labelled ? Math.min(LABEL_EXTRA_MAX, (body.label.length * LABEL_CHAR_WIDTH) / 2) : 0;
    return GRAPH_RADIUS[body.kind] + COLLIDE_PAD * spread + labelExtra;
  };

  let alpha = 1;
  let ticks = 0;

  function tick() {
    if (alpha <= ALPHA_MIN) return;
    ticks += 1;
    alpha = Math.max(ALPHA_MIN, 1 - ticks / TICKS_TO_SETTLE);

    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const length = Math.hypot(dx, dy) || 1;
      const force = ((length - link.distance) / length) * LINK_STRENGTH * alpha;
      const fx = dx * force;
      const fy = dy * force;
      link.source.vx += fx;
      link.source.vy += fy;
      link.target.vx -= fx;
      link.target.vy -= fy;
    }

    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i]!;
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (i - j) * 0.1;
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(d2);
        // Charge: mutual repulsion, capped so far pairs barely matter.
        const force = Math.min(REPULSION_CAP, (CHARGE * spread * alpha) / d2);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
        // Collision: overlapping shapes push apart, labels included in the radius.
        const overlap = collideRadius(a) + collideRadius(b) - distance;
        if (overlap > 0) {
          const push = (overlap / distance) * 0.5 * alpha;
          a.vx -= dx * push;
          a.vy -= dy * push;
          b.vx += dx * push;
          b.vy += dy * push;
        }
      }
    }

    for (const body of bodies) {
      if (preset === "radial") {
        const ring = ringOf(body.kind);
        const dx = body.x - cx;
        const dy = body.y - cy;
        const distance = Math.hypot(dx, dy) || 1;
        const force = ((distance - ring) / distance) * RADIAL_PULL * alpha;
        body.vx -= dx * force;
        body.vy -= dy * force;
        body.vx += (cx - body.x) * 0.01 * alpha;
        body.vy += (cy - body.y) * 0.01 * alpha;
      } else {
        body.vx += (cx - body.x) * CENTER_PULL * alpha;
        body.vy += (cy - body.y) * CENTER_PULL * alpha;
      }
    }

    for (const body of bodies) {
      if (body.pin) {
        body.x = body.pin.x;
        body.y = body.pin.y;
        body.vx = 0;
        body.vy = 0;
        continue;
      }
      body.x += body.vx * VELOCITY_DAMPING;
      body.y += body.vy * VELOCITY_DAMPING;
      body.vx *= VELOCITY_DAMPING;
      body.vy *= VELOCITY_DAMPING;
    }
  }

  return {
    tick,
    positions: () => Object.fromEntries(bodies.map((body) => [body.id, { x: body.x, y: body.y }])),
    setPin: (id, point) => {
      const body = byId.get(id);
      if (body) body.pin = point;
    },
    movePin: (id, point) => {
      const body = byId.get(id);
      if (body) {
        body.pin = point;
        body.x = point.x;
        body.y = point.y;
      }
    },
    settled: () => alpha <= ALPHA_MIN,
    reheat: (next = 0.5) => {
      alpha = Math.max(alpha, next);
      ticks = Math.min(ticks, TICKS_TO_SETTLE * (1 - next));
    },
  };
}
