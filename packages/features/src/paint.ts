import type { Rgb } from "./palette-png";

// Paint editing primitives shared by the draw route. Kept platform-neutral so the
// undo semantics are unit-tested without a canvas.

// Undo/redo for the 192x192 canvas: each snapshot is a full ImageData (~147 KB), so the
// history is depth-capped to keep a long doodle session from growing without bound.
export class PaintHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(private readonly depth = 24) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record the pre-edit snapshot. A new edit always invalidates the redo lane. */
  record(snapshot: T): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.depth) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Pop the previous snapshot, parking the caller's current state on the redo lane. */
  undo(current: T): T | undefined {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return undefined;
    this.redoStack.push(current);
    return snapshot;
  }

  /** Pop the next redo snapshot, parking the caller's current state back on the undo lane. */
  redo(current: T): T | undefined {
    const snapshot = this.redoStack.pop();
    if (snapshot === undefined) return undefined;
    this.undoStack.push(current);
    return snapshot;
  }
}

// Text tool sizes, in canvas pixels (the canvas is 192px shown chunky at 320px).
// Tiny (8px) was added for small captions - the smallest size that stays legible
// when the canvas is scaled up pixelated.
export const TEXT_SIZES = [
  { id: "xs", label: "Tiny", px: 8 },
  { id: "s", label: "Small", px: 12 },
  { id: "m", label: "Medium", px: 20 },
  { id: "l", label: "Large", px: 32 },
] as const;

export type TextSizeId = (typeof TEXT_SIZES)[number]["id"];

export const textSizePx = (id: TextSizeId): number =>
  TEXT_SIZES.find((size) => size.id === id)?.px ?? TEXT_SIZES[0].px;

// Monospace keeps letters legible when the canvas is scaled up pixelated. The flat
// palette encoder snaps the anti-aliased edges to the nearest palette color, so the
// placed text stays low-KB like the brush strokes.
export const textFont = (px: number): string => `${px}px "Courier New", monospace`;

/** Line height for stacked text lines: a little air so rows do not touch. */
export const textLineHeight = (px: number): number => Math.round(px * 1.25);

// Tools that mark the canvas. The draw route also switches cursor and panel behavior
// on this: "brush" and "eraser" stroke, "text" previews and places.
export type PaintTool =
  | "brush"
  | "eraser"
  | "text"
  | "fill"
  | "pick"
  | "spray"
  | "line"
  | "rect"
  | "ellipse";

/** Tools that drag out a shape between pointer-down and pointer-up. */
export const SHAPE_TOOLS = ["line", "rect", "ellipse"] as const;
export const isShapeTool = (tool: PaintTool): boolean => (SHAPE_TOOLS as readonly string[]).includes(tool);

// The canvas starts white and the PNG export snaps pixels to the fixed palette, so the
// eraser paints the paper color instead of punching alpha holes. Paper defaults to
// white - a palette slot - so erased strokes stay palette-indexed and low-KB like every
// other stroke, and erasing is an ordinary undoable paint stroke in the history.
export const ERASE_COLOR = "#ffffff";

/** The color a stroke actually lays down for the given tool. */
export const strokeColor = (tool: PaintTool, color: string, paper: string = ERASE_COLOR): string =>
  tool === "eraser" ? paper : color;

/**
 * Greedy word wrap for the text tool. Newlines in the input are honored first, then
 * each paragraph wraps at maxWidth using the caller's measurement (canvas measureText).
 * A single word wider than maxWidth hard-breaks by characters so nothing is dropped.
 */
export function wrapTextLines(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    const pushWord = (word: string) => {
      if (current === "") {
        let piece = "";
        for (const char of word) {
          if (piece !== "" && measure(piece + char) > maxWidth) {
            lines.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        }
        current = piece;
        return;
      }
      const candidate = `${current} ${word}`;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = "";
        pushWord(word);
      }
    };
    for (const word of paragraph.split(" ").filter((piece) => piece !== "")) pushWord(word);
    lines.push(current);
  }
  return lines;
}

export const hexToRgb = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

export const rgbToHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** Pixel buffer shaped like ImageData, so the fill is unit-tested without a canvas. */
export interface PixelImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Brush edges are anti-aliased, so a strict equal-color fill would leave a halo of
// near-white pixels next to every line. 96 swallows that fringe but still treats a
// mid-gray (#808080) or darker line as a wall.
export const FILL_TOLERANCE = 96;

const channelGap = (data: Uint8ClampedArray, offset: number, seed: Rgb): number =>
  Math.max(
    Math.abs(data[offset] - seed.r),
    Math.abs(data[offset + 1] - seed.g),
    Math.abs(data[offset + 2] - seed.b),
  );

/**
 * Four-connected flood fill, in place. Pixels within `tolerance` (largest channel gap)
 * of the clicked pixel's color and reachable without crossing a different color are set
 * to `fill`. Returns how many pixels changed; 0 means nothing happened (out of bounds,
 * or the region is already exactly that color) so callers can skip an undo entry.
 */
export function floodFill(
  image: PixelImage,
  x: number,
  y: number,
  fill: Rgb,
  tolerance: number = FILL_TOLERANCE,
): number {
  const { data, width, height } = image;
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  const start = (y * width + x) * 4;
  const seed: Rgb = { r: data[start], g: data[start + 1], b: data[start + 2] };
  if (seed.r === fill.r && seed.g === fill.g && seed.b === fill.b) return 0;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [y * width + x];
  seen[y * width + x] = 1;
  let changed = 0;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const px = index % width;
    const py = (index - px) / width;
    const offset = index * 4;
    data[offset] = fill.r;
    data[offset + 1] = fill.g;
    data[offset + 2] = fill.b;
    data[offset + 3] = 255;
    changed += 1;
    const neighbors = [
      px > 0 ? index - 1 : -1,
      px < width - 1 ? index + 1 : -1,
      py > 0 ? index - width : -1,
      py < height - 1 ? index + width : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || seen[next]) continue;
      seen[next] = 1;
      if (channelGap(data, next * 4, seed) <= tolerance) stack.push(next);
    }
  }
  return changed;
}

/** Color under a pixel, or null when out of bounds. */
export function pixelColor(image: PixelImage, x: number, y: number): Rgb | null {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const offset = (y * image.width + x) * 4;
  return { r: image.data[offset], g: image.data[offset + 1], b: image.data[offset + 2] };
}

/** Closest palette entry, so a picked color always lands on a swatch (and stays low-KB). */
export function nearestPaletteHex(color: Rgb, palette: readonly string[]): string {
  let best = palette[0];
  let bestGap = Infinity;
  for (const hex of palette) {
    const candidate = hexToRgb(hex);
    const gap = (candidate.r - color.r) ** 2 + (candidate.g - color.g) ** 2 + (candidate.b - color.b) ** 2;
    if (gap < bestGap) {
      bestGap = gap;
      best = hex;
    }
  }
  return best;
}

/** Small seeded generator: spray is reproducible, so tests can assert exact coverage. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random dots inside a disc: the spray-can pattern for one pointer event. */
export function sprayDots(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  random: () => number,
): { x: number; y: number }[] {
  const dots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * radius;
    dots.push({ x: Math.round(cx + Math.cos(angle) * distance), y: Math.round(cy + Math.sin(angle) * distance) });
  }
  return dots;
}

/** Box between two drag corners, in either direction. */
export function dragBox(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
