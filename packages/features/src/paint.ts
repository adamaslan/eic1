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
export const TEXT_SIZES = [
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
