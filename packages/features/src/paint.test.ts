import { describe, expect, it } from "vitest";
import { ERASE_COLOR, PaintHistory, TEXT_SIZES, dragBox, floodFill, hexToRgb, nearestPaletteHex, pixelColor, seededRandom, sprayDots, strokeColor, textFont, textSizePx, wrapTextLines, type PixelImage, type TextSizeId } from "./paint";

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

describe("strokeColor", () => {
  it("eraser always paints the white background color", () => {
    expect(ERASE_COLOR).toBe("#ffffff");
    expect(strokeColor("eraser", "#000000")).toBe(ERASE_COLOR);
    expect(strokeColor("eraser", "#ff0000")).toBe("#ffffff");
  });

  it("brush and text keep the chosen color", () => {
    expect(strokeColor("brush", "#800000")).toBe("#800000");
    expect(strokeColor("text", "#000080")).toBe("#000080");
  });
});

describe("paper color", () => {
  it("eraser reveals the chosen paper color instead of fixed white", () => {
    expect(strokeColor("eraser", "#000000", "#ffff00")).toBe("#ffff00");
    expect(strokeColor("eraser", "#000000")).toBe("#ffffff");
  });
});

describe("wrapTextLines", () => {
  // Fixed-width fake measure: every character is 1 unit.
  const measure = (text: string) => text.length;

  it("honors explicit newlines before wrapping", () => {
    expect(wrapTextLines(measure, "ab\ncd", 10)).toEqual(["ab", "cd"]);
  });

  it("wraps words greedily at the width limit", () => {
    expect(wrapTextLines(measure, "aa bb cc", 5)).toEqual(["aa bb", "cc"]);
  });

  it("hard-breaks a word longer than the width so nothing is dropped", () => {
    expect(wrapTextLines(measure, "abcdef", 3)).toEqual(["abc", "def"]);
  });

  it("keeps empty lines from consecutive newlines", () => {
    expect(wrapTextLines(measure, "a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("wraps a long paragraph with mixed newlines", () => {
    expect(wrapTextLines(measure, "one two\nthree four five", 9)).toEqual(["one two", "three", "four five"]);
  });
});

const solid = (width: number, height: number, hex: string): PixelImage => {
  const { r, g, b } = hexToRgb(hex);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([r, g, b, 255], i * 4);
  return { data, width, height };
};
const paintPx = (image: PixelImage, x: number, y: number, hex: string) => {
  const { r, g, b } = hexToRgb(hex);
  image.data.set([r, g, b, 255], (y * image.width + x) * 4);
};
const countHex = (image: PixelImage, hex: string) => {
  const want = hexToRgb(hex);
  let n = 0;
  for (let y = 0; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1) {
      const c = pixelColor(image, x, y)!;
      if (c.r === want.r && c.g === want.g && c.b === want.b) n += 1;
    }
  return n;
};

describe("floodFill", () => {
  // 7x7 white field with a closed 5x5 black ring at the border of the inner area.
  const ring = (gap: boolean) => {
    const image = solid(7, 7, "#ffffff");
    for (let i = 1; i <= 5; i += 1) {
      paintPx(image, i, 1, "#000000");
      paintPx(image, i, 5, "#000000");
      paintPx(image, 1, i, "#000000");
      paintPx(image, 5, i, "#000000");
    }
    if (gap) paintPx(image, 3, 1, "#ffffff");
    return image;
  };

  it("fills only the enclosed region", () => {
    const image = ring(false);
    expect(floodFill(image, 3, 3, hexToRgb("#ff0000"))).toBe(9);
    expect(countHex(image, "#ff0000")).toBe(9);
    expect(countHex(image, "#000000")).toBe(16);
    expect(countHex(image, "#ffffff")).toBe(49 - 16 - 9);
  });

  it("negative control: a gap in the wall leaks the fill outside", () => {
    const image = ring(true);
    expect(floodFill(image, 3, 3, hexToRgb("#ff0000"))).toBe(49 - 15);
    expect(countHex(image, "#ffffff")).toBe(0);
  });

  it("does nothing when the region already has the fill color or the click is outside", () => {
    const image = solid(4, 4, "#ff0000");
    expect(floodFill(image, 1, 1, hexToRgb("#ff0000"))).toBe(0);
    expect(floodFill(image, -1, 0, hexToRgb("#00ff00"))).toBe(0);
    expect(floodFill(image, 4, 0, hexToRgb("#00ff00"))).toBe(0);
  });

  it("tolerance swallows an anti-aliased fringe but a mid-gray wall still holds", () => {
    const fringe = solid(5, 1, "#ffffff");
    paintPx(fringe, 2, 0, "#e0e0e0");
    expect(floodFill(fringe, 0, 0, hexToRgb("#00ff00"))).toBe(5);
    const wall = solid(5, 1, "#ffffff");
    paintPx(wall, 2, 0, "#808080");
    expect(floodFill(wall, 0, 0, hexToRgb("#00ff00"))).toBe(2);
    const strict = solid(5, 1, "#ffffff");
    paintPx(strict, 2, 0, "#e0e0e0");
    expect(floodFill(strict, 0, 0, hexToRgb("#00ff00"), 0)).toBe(2);
  });
});

describe("pick and palette helpers", () => {
  it("reads pixel color and snaps to the nearest palette swatch", () => {
    const image = solid(2, 2, "#fe0101");
    expect(pixelColor(image, 9, 9)).toBeNull();
    expect(nearestPaletteHex(pixelColor(image, 1, 1)!, ["#000000", "#ff0000", "#ffffff"])).toBe("#ff0000");
  });
});

describe("spray and drag box", () => {
  it("spray is reproducible and stays inside the disc", () => {
    const a = sprayDots(50, 50, 10, 40, seededRandom(7));
    const b = sprayDots(50, 50, 10, 40, seededRandom(7));
    const c = sprayDots(50, 50, 10, 40, seededRandom(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((dot) => Math.hypot(dot.x - 50, dot.y - 50) <= 10.8)).toBe(true);
  });

  it("dragBox normalizes any drag direction", () => {
    expect(dragBox({ x: 10, y: 20 }, { x: 4, y: 30 })).toEqual({ x: 4, y: 20, w: 6, h: 10 });
  });
});
