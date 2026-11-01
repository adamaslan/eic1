import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router";
import {
  buildSocialGraph,
  createGraphLayout,
  GRAPH_RADIUS,
  GRAPH_SPREAD_MAX,
  GRAPH_SPREAD_MIN,
  ME_NODE_ID,
  type GraphLayout,
  type GraphNode,
  type GraphPoint,
  type GraphPreset,
  type SocialGraph,
} from "@veil/features";
import type { Route } from "./+types/graph";
import { Bevel } from "~/ui95/Bevel";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSocial } from "~/platform/use-social";
import { useSessionStore } from "~/platform/session";

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
  const { items, settings, settingsReady, connections } = useSocial(vault);

  const graph = useMemo(() => {
    const list = items.status === "ready" ? items.items : [];
    return buildSocialGraph({ myHandle: settingsReady ? settings.handle : null, connections, items: list });
  }, [items, settingsReady, settings.handle, connections]);

  const degree = useMemo(() => degreesOf(graph), [graph]);
  const [preset, setPreset] = useState<GraphPreset>("radial");
  const [spread, setSpread] = useState<number>(() => loadSpread());
  const [positions, setPositions] = useState<Record<string, GraphPoint>>({});
  const [pinned, setPinned] = useState<PinMap>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
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
    const pins = loadPins(graph);
    setPinned(pins);
    const layout = createGraphLayout(graph, {
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
  }, [graph, preset, spread, W, H]);

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

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selectedEdges = selected ? graph.edges.filter((e) => e.source === selected.id || e.target === selected.id) : [];

  const visibleConnections = connections.filter((c) => !c.hidden).length;
  const posts = graph.nodes.filter((node) => node.kind === "post").length;
  const listings = graph.nodes.filter((node) => node.kind === "listing").length;
  const likes = graph.edges.filter((edge) => edge.kind === "likes").length;
  const empty = graph.nodes.length === 1;

  return (
    <div className="flex flex-col gap-3">
      <Window title="Social graph">
        <div className="flex flex-col gap-2 text-[12px] text-[#0a0a0a]">
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

          {empty ? (
            <p>
              Nothing to map yet. Add a connection or a post and it shows up here.{" "}
              <Link to="/connections" className="text-[#0000cc] underline">Connections</Link>
              {" · "}
              <Link to="/compose" className="text-[#0000cc] underline">New post</Link>
            </p>
          ) : showList ? (
            <ul className="flex flex-col gap-1">
              {graph.nodes.map((node) => (
                <li key={node.id} className="bg-white px-1.5 py-1">
                  <Link to={node.href} className="font-bold text-[#0000cc] underline">
                    {node.label}
                  </Link>
                  <span className="text-[#404040]">
                    {" "}— {KIND_LABEL[node.kind]}, {degree.get(node.id) ?? 0} {(degree.get(node.id) ?? 0) === 1 ? "link" : "links"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Bevel variant="in">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                role="application"
                aria-label="Social graph: you, your connections, posts and listings"
                className="block h-auto w-full touch-none select-none bg-white"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {graph.edges.map((edge) => {
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
                {graph.nodes.map((node) => {
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

          <p className="text-[11px] text-[#404040]">
            {visibleConnections} {visibleConnections === 1 ? "person" : "people"} · {posts} {posts === 1 ? "post" : "posts"} · {listings} {listings === 1 ? "listing" : "listings"} · {likes} {likes === 1 ? "like" : "likes"}.
            Drag a node to pin it. Square is you, circle is a person or post, diamond is a listing.
            {graph.hiddenConnections > 0 && ` ${graph.hiddenConnections} hidden ${graph.hiddenConnections === 1 ? "connection stays" : "connections stay"} out of the map.`}
            {graph.truncatedItems > 0 && ` Showing the 100 newest items; ${graph.truncatedItems} older left off.`}
          </p>
        </div>
      </Window>

      {selected && (
        <Window title={`Details — ${KIND_LABEL[selected.kind]}`}>
          <div className="flex flex-col gap-1 text-[12px] text-[#0a0a0a]">
            <p className="font-bold">{selected.label}</p>
            <p>
              <Link to={selected.href} className="text-[#0000cc] underline">
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
