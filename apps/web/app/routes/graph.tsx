import { Avatar } from "~/components/avatar";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  buildSocialGraph,
  MAX_GRAPH_ITEMS,
  createGraphLayout,
  emptyGraphFilter,
  filterSocialGraph,
  isGraphFilterActive,
  type GraphFilter,
  GRAPH_RADIUS,
  GRAPH_SPREAD_MAX,
  GRAPH_SPREAD_MIN,
  ME_NODE_ID,
  resolveGraphFocus,
  type GraphLayout,
  type GraphNode,
  type GraphPoint,
  type GraphPreset,
  type SocialGraph,
  graphBodyState,
} from "@veil/features";
import type { Route } from "./+types/graph";
import { Bevel } from "~/ui95/Bevel";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSocial } from "~/platform/use-social";
import { useSessionStore } from "~/platform/session";
import { useFeatureEnabled } from "~/platform/use-gate";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Graph — Everybody is Cool" }];
}

// Interaction logic follows the Ulysses graph app Adam pointed at: force placement that a
// spread slider retunes live, drag-to-pin kept in localStorage, presets that re-place the
// graph without losing pins, and an instant static settle under reduced motion. The
// simulation itself is dependency-free in @veil/features (see graph.ts), keeping the
// bundle small per the app's low-KB intent.
const WIDE = { w: 640, h: 420 };
const COMPACT = { w: 400, h: 380 };
const SPREAD_DEFAULT = 1;

const FILL: Record<GraphNode["kind"], string> = {
  me: "#000080",
  connection: "#1084d0",
  post: "#008080",
  listing: "#808080",
};

const PINS_KEY = "eic-graph-pins:v1";
const SPREAD_KEY = "eic-graph-spread:v1";

type PinMap = Record<string, GraphPoint>;

function loadPins(graph: SocialGraph): PinMap {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null") as PinMap | null;
    if (!raw || typeof raw !== "object") return {};
    const ids = new Set(graph.nodes.map((node) => node.id));
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([id, pin]) => ids.has(id) && Number.isFinite(pin?.x) && Number.isFinite(pin?.y),
      ),
    );
  } catch {
    return {};
  }
}

function savePins(pins: PinMap) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* storage blocked: pins last for this visit only */
  }
}

// Merge with what is stored instead of overwriting: while a filter hides nodes, their
// pins are not in the applied set, and a plain overwrite would silently forget them.
function savePinsMerged(currentGraphIds: Set<string>, applied: PinMap) {
  try {
    const stored = (JSON.parse(localStorage.getItem(PINS_KEY) ?? "null") ?? {}) as PinMap;
    const next: PinMap = {};
    for (const [id, pin] of Object.entries(stored)) {
      if (!currentGraphIds.has(id) && Number.isFinite(pin?.x) && Number.isFinite(pin?.y)) next[id] = pin;
    }
    Object.assign(next, applied);
    localStorage.setItem(PINS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: pins last for this visit only */
  }
}

function loadSpread(): number {
  try {
    const value = Number(localStorage.getItem(SPREAD_KEY));
    return Number.isFinite(value) && value >= GRAPH_SPREAD_MIN && value <= GRAPH_SPREAD_MAX ? value : SPREAD_DEFAULT;
  } catch {
    return SPREAD_DEFAULT;
  }
}

function degreesOf(graph: SocialGraph): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

// Fit view: the layout works in a fixed W x H box, but settled positions can fall outside
// it (sparse graphs fan nodes past the edges). The viewBox is the fixed box EXPANDED to
// cover every shown node plus its label, at the SAME W:H aspect so the canvas never
// changes size and pushes the caption out of the fixed-height window. Small graphs keep
// the exact baseline box; overflow stays reachable instead of clipping at the canvas edge.
const FIT_PAD = 28; // covers the largest node radius (22) with margin
const FIT_LABEL = 16; // node labels render up to ~12px below the node
function fitViewBox(positions: Record<string, GraphPoint>, width: number, height: number): string {
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  for (const point of Object.values(positions)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x - FIT_PAD);
    minY = Math.min(minY, point.y - FIT_PAD);
    maxX = Math.max(maxX, point.x + FIT_PAD);
    maxY = Math.max(maxY, point.y + FIT_PAD + FIT_LABEL);
  }
  const scale = Math.max((maxX - minX) / width, (maxY - minY) / height);
  if (scale <= 1) return `0 0 ${width} ${height}`;
  const boxW = width * scale;
  const boxH = height * scale;
  const x0 = minX - (boxW - (maxX - minX)) / 2;
  const y0 = minY - (boxH - (maxY - minY)) / 2;
  return `${x0} ${y0} ${boxW} ${boxH}`;
}

function diamondPath(r: number): string {
  return `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`;
}

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  me: "You",
  connection: "Connection",
  post: "Feed post",
  listing: "Market listing",
};

export default function Graph() {
  const vault = useSessionStore((state) => state.vault);
  const graphEnabled = useFeatureEnabled(vault, "graph");
  const { items, settings, settingsReady, connections, refresh } = useSocial(vault);

  // Windowed browsing of the item nodes: the default window is the newest 100 items; older
  // windows page backward. Not persisted - which window you browsed is visit state, and the
  // graph always opens on the newest items.
  const [itemOffset, setItemOffset] = useState(0);
  const graph = useMemo(() => {
    const list = items.status === "ready" ? items.items : [];
    return buildSocialGraph(
      { myHandle: settingsReady ? settings.handle : null, connections, items: list },
      { itemOffset },
    );
  }, [items, settingsReady, settings.handle, connections, itemOffset]);

  // Kind toggles and a label search narrow the shown graph. Filters are deliberately not
  // persisted: a search can name something private, and what you filtered for should not
  // outlive the visit.
  const [filter, setFilter] = useState<GraphFilter>(emptyGraphFilter);
  const filtered = useMemo(() => filterSocialGraph(graph, filter), [graph, filter]);
  const shownGraph = filtered.graph;
  const filterActive = isGraphFilterActive(filter);

  const degree = useMemo(() => degreesOf(graph), [graph]);
  const [preset, setPreset] = useState<GraphPreset>("radial");
  const [spread, setSpread] = useState<number>(() => loadSpread());
  const [positions, setPositions] = useState<Record<string, GraphPoint>>({});
  const [pinned, setPinned] = useState<PinMap>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  const [focusMissed, setFocusMissed] = useState(false);
  const [showList, setShowList] = useState(false);
  useEffect(() => {
    setSelectedId(null);
  }, [itemOffset]);
  const [compact, setCompact] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)").matches : false,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const onChange = () => setCompact(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const W = compact ? COMPACT.w : WIDE.w;
  const H = compact ? COMPACT.h : WIDE.h;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const layoutRef = useRef<GraphLayout | null>(null);
  const positionsRef = useRef<Record<string, GraphPoint>>({});
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);

  // (Re)create the layout on data, preset, or spread changes. Current positions feed back
  // as the start, so retuning settles gently instead of scattering the graph (Ulysses
  // behavior). Ticks run a few per frame; reduced motion settles synchronously, one render.
  useEffect(() => {
    const pins = loadPins(shownGraph);
    setPinned(pins);
    const layout = createGraphLayout(shownGraph, {
      width: W,
      height: H,
      preset,
      spread,
      pins,
      start: positionsRef.current,
    });
    layoutRef.current = layout;

    const publish = () => {
      positionsRef.current = layout.positions();
      setPositions(positionsRef.current);
    };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      while (!layout.settled()) layout.tick();
      publish();
      return () => {
        layoutRef.current = null;
      };
    }
    let frame = 0;
    const step = () => {
      layout.tick();
      layout.tick();
      publish();
      if (!layout.settled()) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      layoutRef.current = null;
    };
  }, [shownGraph, preset, spread, W, H]);

  // While dragging, keep ticking so neighbours give way around the dragged node.
  useEffect(() => {
    let frame = 0;
    const step = () => {
      const layout = layoutRef.current;
      const dragging = dragRef.current?.moved === true;
      if (layout && dragging) {
        layout.reheat(0.3);
        layout.tick();
        positionsRef.current = layout.positions();
        setPositions(positionsRef.current);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  function changeSpread(next: number) {
    setSpread(next);
    try {
      localStorage.setItem(SPREAD_KEY, String(next));
    } catch {
      /* storage blocked */
    }
  }

  function toGraphPoint(event: ReactPointerEvent<SVGSVGElement>): GraphPoint | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  function onNodePointerDown(nodeId: string, event: ReactPointerEvent<SVGGElement>) {
    event.preventDefault();
    dragRef.current = { id: nodeId, moved: false };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    const layout = layoutRef.current;
    if (!drag || !layout) return;
    const point = toGraphPoint(event);
    if (!point) return;
    drag.moved = true;
    layout.movePin(drag.id, point);
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) {
      setSelectedId((current) => (current === drag.id ? null : drag.id));
      return;
    }
    // Drag ends pin the node where it was dropped (Ulysses behavior) and persist.
    const point = layoutRef.current?.positions()[drag.id];
    if (point) {
      const next = { ...pinned, [drag.id]: point };
      setPinned(next);
      savePins(next);
    }
  }

  function unpinAll() {
    const layout = layoutRef.current;
    for (const id of Object.keys(pinned)) layout?.setPin(id, null);
    setPinned({});
    savePins({});
    layout?.reheat(0.6);
    // Kick the frame loop via state so the layout visibly settles again.
    setPositions((current) => ({ ...current }));
  }

  const nodeById = useMemo(() => new Map(shownGraph.nodes.map((node) => [node.id, node])), [shownGraph]);
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  // A filter can hide the selected node; drop the selection so the details window never
  // describes something that is no longer on the map.
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [nodeById, selectedId]);
  const selectedEdges = selected ? shownGraph.edges.filter((e) => e.source === selected.id || e.target === selected.id) : [];

  const visibleConnections = connections.filter((c) => !c.hidden).length;
  const totalPosts = graph.nodes.filter((node) => node.kind === "post").length;
  const totalListings = graph.nodes.filter((node) => node.kind === "listing").length;
  const posts = shownGraph.nodes.filter((node) => node.kind === "post").length;
  const listings = shownGraph.nodes.filter((node) => node.kind === "listing").length;
  const shownConnections = shownGraph.nodes.filter((node) => node.kind === "connection").length;
  const likes = shownGraph.edges.filter((edge) => edge.kind === "likes").length;
  const bodyState = graphBodyState(items.status, graph.nodes.length);

  // A ?focus= link from the connections screen preselects that person once the map is built.
  // A hidden or unknown connection resolves to nothing and says so - hiding always wins.
  useEffect(() => {
    if (!focusParam) {
      setFocusMissed(false);
      return;
    }
    if (bodyState === "loading" || bodyState === "error") return;
    const target = resolveGraphFocus(shownGraph, focusParam);
    if (target) {
      setSelectedId(target);
      setFocusMissed(false);
    } else {
      setFocusMissed(true);
    }
    // Only react to a new focus target, not to every graph rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, bodyState]);

  if (!graphEnabled) {
    return (
      <p className="text-[12px]">
        The map is turned off in Tools. Nothing is deleted - turn it back on any time and your people and posts show up again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Window title="Social graph">
        <div className="flex flex-col gap-2 text-[12px] text-[var(--w95-ink)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">Layout:</span>
            {(["radial", "free"] as const).map((option) => (
              <Button95 key={option} pressed={preset === option} onClick={() => setPreset(option)}>
                {option === "radial" ? "Radial" : "Free"}
              </Button95>
            ))}
            <label className="flex items-center gap-1">
              Spread
              <input
                type="range"
                min={GRAPH_SPREAD_MIN}
                max={GRAPH_SPREAD_MAX}
                step={0.05}
                value={spread}
                onChange={(event) => changeSpread(Number(event.target.value))}
                aria-label="Graph spread"
              />
            </label>
            <Button95 onClick={unpinAll} disabled={Object.keys(pinned).length === 0}>
              Unpin all
            </Button95>
            <Button95 pressed={showList} onClick={() => setShowList((value) => !value)}>
              {showList ? "Graph" : "List"}
            </Button95>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="font-bold">Filter:</span>
              <input
                aria-label="Filter by name or title"
                placeholder="Name or title"
                value={filter.query}
                onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
                className="w-36 bg-white px-1.5 py-1 text-[12px] text-[var(--w95-ink)] outline-none"
              />
            </label>
            {(["connection", "post", "listing"] as const).map((kind) => (
              <Button95
                key={kind}
                pressed={filter.kinds[kind]}
                onClick={() => setFilter((current) => ({ ...current, kinds: { ...current.kinds, [kind]: !current.kinds[kind] } }))}
              >
                {kind === "connection" ? "People" : kind === "post" ? "Posts" : "Listings"}
              </Button95>
            ))}
            {filterActive && (
              <Button95 onClick={() => setFilter(emptyGraphFilter)}>Clear filter</Button95>
            )}
          </div>

          {graph.graphableItems > MAX_GRAPH_ITEMS && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">Items:</span>
              <Button95
                onClick={() => setItemOffset((current) => Math.max(0, current - MAX_GRAPH_ITEMS))}
                disabled={graph.itemWindowStart === 0}
              >
                Newer 100
              </Button95>
              <Button95
                onClick={() => setItemOffset((current) => current + MAX_GRAPH_ITEMS)}
                disabled={graph.truncatedItems === 0}
              >
                Older 100
              </Button95>
              {graph.itemWindowStart > 0 && (
                <Button95 onClick={() => setItemOffset(0)}>Back to newest</Button95>
              )}
            </div>
          )}

          {focusMissed && (
            <p role="status" className="bg-[#ffffe1] px-1 text-[#800000]">
              That connection is not on the map. Hidden connections stay off it.
            </p>
          )}
          {bodyState === "loading" ? (
            <p>Loading your map…</p>
          ) : bodyState === "error" ? (
            <p role="alert" className="text-[#800000]">
              {items.status === "error" ? items.message : "This vault could not be read."}{" "}
              <button type="button" onClick={refresh} className="text-[var(--w95-link)] underline">
                Try again
              </button>
            </p>
          ) : bodyState === "empty" ? (
            <p>
              Nothing to map yet. Add a connection or a post and it shows up here.{" "}
              <Link to="/connections" className="text-[var(--w95-link)] underline">Connections</Link>
              {" · "}
              <Link to="/compose" className="text-[var(--w95-link)] underline">New post</Link>
            </p>
          ) : filterActive && shownGraph.nodes.length <= 1 ? (
            <p>
              Nothing shows with the current filters.{filter.query.trim() !== "" && " No matching names or titles."}{" "}
              <button type="button" onClick={() => setFilter(emptyGraphFilter)} className="text-[var(--w95-link)] underline">
                Clear the filter
              </button>
            </p>
          ) : showList ? (
            <ul className="flex flex-col gap-1">
              {shownGraph.nodes.map((node) => {
                const isSelected = node.id === selectedId;
                return (
                  <li key={node.id} className={isSelected ? "bg-[var(--w95-face)] px-1.5 py-1" : "bg-white px-1.5 py-1"}>
                    <Link to={node.href} className="font-bold text-[var(--w95-link)] underline">
                      {(node.kind === "me" || node.kind === "connection") && <Avatar authorId={node.kind === "me" ? undefined : node.id.slice("connection:".length)} label={`${node.label}'s avatar`} />} {node.label}
                    </Link>
                    <span className="text-[var(--w95-muted)]">
                      {" "}— {KIND_LABEL[node.kind]}, {degree.get(node.id) ?? 0} {(degree.get(node.id) ?? 0) === 1 ? "link" : "links"}
                    </span>
                    {" "}
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`Details for ${node.label}`}
                      onClick={() => setSelectedId(isSelected ? null : node.id)}
                      className="text-[var(--w95-link)] underline outline-none focus:outline-2 focus:outline-dotted focus:outline-[var(--w95-ink)]"
                    >
                      Details
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Bevel variant="in">
              <svg
                ref={svgRef}
                viewBox={fitViewBox(positions, W, H)}
                role="application"
                aria-label="Social graph: you, your connections, posts and listings"
                className="block h-auto w-full touch-none select-none bg-white"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {shownGraph.edges.map((edge) => {
                  const source = positions[edge.source];
                  const target = positions[edge.target];
                  if (!source || !target) return null;
                  const active = selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
                  return (
                    <line
                      key={edge.id}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={edge.kind === "connected" ? "#000080" : edge.kind === "likes" ? "#1084d0" : "#5a5a5a"}
                      strokeWidth={active ? 2 : 1}
                      strokeDasharray={edge.kind === "likes" ? "4 3" : undefined}
                      opacity={selectedId === null || active ? 1 : 0.35}
                    />
                  );
                })}
                {shownGraph.nodes.map((node) => {
                  const position = positions[node.id];
                  if (!position) return null;
                  const isSelected = node.id === selectedId;
                  const dimmed = selectedId !== null && !isSelected &&
                    !graph.edges.some(
                      (e) =>
                        (e.source === selectedId && e.target === node.id) ||
                        (e.target === selectedId && e.source === node.id),
                    );
                  const labelled = node.kind === "me" || node.kind === "connection" || isSelected;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${position.x}, ${position.y})`}
                      opacity={dimmed ? 0.35 : 1}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.label} (${KIND_LABEL[node.kind]})`}
                      style={{ cursor: "pointer", outline: "none" }}
                      onPointerDown={(event) => onNodePointerDown(node.id, event)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId((current) => (current === node.id ? null : node.id));
                        }
                      }}
                    >
                      <title>{node.label}</title>
                      <circle r={22} fill="transparent" />
                      {node.kind === "listing" ? (
                        <path d={diamondPath(GRAPH_RADIUS.listing + 1)} fill={FILL.listing} stroke={isSelected ? "#000080" : "#0a0a0a"} strokeWidth={isSelected ? 2 : 1} />
                      ) : node.kind === "me" ? (
                        <rect x={-GRAPH_RADIUS.me} y={-GRAPH_RADIUS.me} width={GRAPH_RADIUS.me * 2} height={GRAPH_RADIUS.me * 2} fill={FILL.me} stroke={isSelected ? "#ffffff" : "#0a0a0a"} strokeWidth={isSelected ? 2 : 1} />
                      ) : (
                        <circle r={GRAPH_RADIUS[node.kind]} fill={FILL[node.kind]} stroke={isSelected ? "#000080" : "#0a0a0a"} strokeWidth={isSelected ? 2 : 1} />
                      )}
                      {(node.kind === "me" || node.kind === "connection") && <Avatar svg size={24} authorId={node.kind === "me" ? undefined : node.id.slice("connection:".length)} label={`${node.label}'s avatar`} />}
                      {labelled && (
                        <text x={0} y={GRAPH_RADIUS[node.kind] + 12} textAnchor="middle" fontSize={compact ? 12 : 10} fill="#0a0a0a" style={{ pointerEvents: "none", fontFamily: "Courier New, monospace" }}>
                          {node.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </Bevel>
          )}

          <p className="text-[11px] text-[var(--w95-muted)]">
            {filterActive
              ? `Showing ${shownConnections} of ${visibleConnections} ${visibleConnections === 1 ? "person" : "people"} · ${posts} of ${totalPosts} ${totalPosts === 1 ? "post" : "posts"} · ${listings} of ${totalListings} ${totalListings === 1 ? "listing" : "listings"} · ${likes} ${likes === 1 ? "like" : "likes"}.`
              : `${visibleConnections} ${visibleConnections === 1 ? "person" : "people"} · ${posts} ${posts === 1 ? "post" : "posts"} · ${listings} ${listings === 1 ? "listing" : "listings"} · ${likes} ${likes === 1 ? "like" : "likes"}.`}
            {" "}Drag a node to pin it. Square is you, circle is a person or post, diamond is a listing.
            {graph.hiddenConnections > 0 && ` ${graph.hiddenConnections} hidden ${graph.hiddenConnections === 1 ? "connection stays" : "connections stay"} out of the map.`}
            {graph.truncatedItems > 0 && graph.itemWindowStart === 0 && ` Showing the 100 newest items; ${graph.truncatedItems} older left off.`}
            {graph.itemWindowStart > 0 && ` Showing items ${graph.itemWindowStart + 1}–${graph.itemWindowStart + totalPosts + totalListings} of ${graph.graphableItems}, newest first.`}
            {graph.newerItems > 0 && ` ${graph.newerItems} newer ${graph.newerItems === 1 ? "item is" : "items are"} on a newer window.`}
            {graph.truncatedItems > 0 && graph.itemWindowStart > 0 && ` ${graph.truncatedItems} older left off.`}
            {filterActive && filter.query.trim() !== "" && (graph.truncatedItems > 0 || graph.newerItems > 0) && " Filters search only the mapped items, not the ones on other windows."}
          </p>
        </div>
      </Window>

      {selected && (
        <Window title={`Details — ${KIND_LABEL[selected.kind]}`}>
          <div className="flex flex-col gap-1 text-[12px] text-[var(--w95-ink)]">
            <p className="font-bold">{selected.label}</p>
            <p>
              <Link to={selected.href} className="text-[var(--w95-link)] underline">
                {selected.kind === "me" ? "Open your profile" : selected.kind === "connection" ? "Open profile" : "Open in full"}
              </Link>
            </p>
            {selectedEdges.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {selectedEdges.map((edge) => {
                  const other = nodeById.get(edge.source === selected.id ? edge.target : edge.source);
                  if (!other) return null;
                  const verb =
                    edge.kind === "connected"
                      ? "is your connection"
                      : edge.kind === "authors"
                        ? edge.source === selected.id
                          ? "authored"
                          : "was authored by"
                        : edge.source === selected.id
                          ? "liked"
                          : "is liked by";
                  return (
                    <li key={edge.id}>
                      {verb} <span className="font-bold">{other.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Window>
      )}
    </div>
  );
}
