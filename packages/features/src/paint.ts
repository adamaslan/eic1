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
export type PaintTool = "brush" | "eraser" | "text";

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
