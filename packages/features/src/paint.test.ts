import { describe, expect, it } from "vitest";
import { PaintHistory, TEXT_SIZES, textFont, textSizePx, type TextSizeId } from "./paint";

describe("PaintHistory", () => {
  it("starts with nothing to undo or redo", () => {
    const history = new PaintHistory<string>();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo("current")).toBeUndefined();
    expect(history.redo("current")).toBeUndefined();
  });

  it("undoes back through recorded snapshots in reverse order", () => {
    const history = new PaintHistory<string>();
    history.record("blank");
    history.record("one stroke");
    expect(history.canUndo).toBe(true);

    expect(history.undo("two strokes")).toBe("one stroke");
    expect(history.undo("one stroke")).toBe("blank");
    expect(history.canUndo).toBe(false);
    expect(history.undo("blank")).toBeUndefined();
  });

  it("redoes forward and round-trips every snapshot", () => {
    const history = new PaintHistory<string>();
    history.record("blank");
    history.record("one stroke");

    expect(history.undo("two strokes")).toBe("one stroke");
    expect(history.canRedo).toBe(true);
    expect(history.redo("one stroke")).toBe("two strokes");
    expect(history.canRedo).toBe(false);
    // The state we just redid into is itself undoable.
    expect(history.undo("two strokes")).toBe("one stroke");
  });

  it("clears the redo lane when a new edit lands after an undo", () => {
    const history = new PaintHistory<string>();
    history.record("blank");
    history.undo("stroke A");
    expect(history.canRedo).toBe(true);

    history.record("blank");
    expect(history.canRedo).toBe(false);
    expect(history.redo("stroke B")).toBeUndefined();
  });

  it("caps the undo depth and drops the oldest snapshots", () => {
    const history = new PaintHistory<number>(3);
    for (let edit = 1; edit <= 6; edit += 1) history.record(edit);

    expect(history.undo(7)).toBe(6);
    expect(history.undo(6)).toBe(5);
    expect(history.undo(5)).toBe(4);
    // 1, 2, 3 fell off the cap; 4 is the floor.
    expect(history.canUndo).toBe(false);
    expect(history.undo(4)).toBeUndefined();
  });

  it("survives undo/redo churn without losing the oldest in-depth snapshot", () => {
    const history = new PaintHistory<number>(2);
    history.record(1);
    history.record(2);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBe(1);
    expect(history.redo(1)).toBe(2);
    expect(history.redo(2)).toBe(3);
    expect(history.canRedo).toBe(false);
  });
});

describe("text tool sizes", () => {
  it("maps every declared size id to its pixel size", () => {
    for (const size of TEXT_SIZES) {
      expect(textSizePx(size.id)).toBe(size.px);
    }
    expect(new Set(TEXT_SIZES.map((size) => size.id)).size).toBe(TEXT_SIZES.length);
  });

  it("orders sizes small to large so the canvas stays readable", () => {
    const pixels = TEXT_SIZES.map((size) => size.px);
    expect([...pixels].sort((a, b) => a - b)).toEqual(pixels);
    expect(pixels[0]).toBeGreaterThanOrEqual(8);
    expect(pixels[pixels.length - 1]).toBeLessThanOrEqual(48);
  });

  it("falls back to the smallest size for an unknown id", () => {
    expect(textSizePx("unknown" as TextSizeId)).toBe(TEXT_SIZES[0].px);
  });
});

describe("textFont", () => {
  it("builds a monospace canvas font at the requested size", () => {
    expect(textFont(12)).toBe('12px "Courier New", monospace');
    expect(textFont(32)).toContain("32px");
  });
});
