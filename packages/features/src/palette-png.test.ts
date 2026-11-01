import { describe, expect, it } from "vitest";
import { crc32, encodePalettePng, nearestPaletteIndex } from "./palette-png";

const PALETTE = [
  { r: 0, g: 0, b: 0 },       // black
  { r: 255, g: 0, b: 0 },     // red
  { r: 255, g: 255, b: 255 }, // white (background, last)
];

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal PNG reader for round-trip checks: parses IHDR/PLTE/IDAT, inflates, returns index rows. */
async function decodeIndexedPng(png: Uint8Array) {
  expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let plte: number[] = [];
  let idat = new Uint8Array(0);
  const chunks: string[] = [];
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const data = png.subarray(offset + 8, offset + 8 + length);
    // CRC must check out for every chunk.
    const crcInput = png.subarray(offset + 4, offset + 8 + length);
    expect(view.getUint32(8 + length)).toBe(crc32(crcInput));
    chunks.push(type);
    if (type === "IHDR") {
      const dv = new DataView(data.buffer, data.byteOffset);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(3); // indexed
      expect(data[12]).toBe(0); // no interlace
    } else if (type === "PLTE") {
      plte = [...data];
    } else if (type === "IDAT") {
      const merged = new Uint8Array(idat.length + data.length);
      merged.set(idat, 0);
      merged.set(data, idat.length);
      idat = merged;
    }
    offset += 12 + length;
  }
  expect(chunks[0]).toBe("IHDR");
  expect(chunks[chunks.length - 1]).toBe("IEND");
  const raw = await inflate(idat);
  const rows: number[][] = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width);
    expect(raw[start]).toBe(0); // filter: none
    rows.push([...raw.subarray(start + 1, start + 1 + width)]);
  }
  return { width, height, plte, rows };
}

function pixels(entries: [r: number, g: number, b: number, a?: number][]): Uint8Array {
  const out = new Uint8Array(entries.length * 4);
  entries.forEach(([r, g, b, a = 255], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  });
  return out;
}

describe("nearestPaletteIndex", () => {
  it("picks exact and nearest colors, snapping antialiased blends", () => {
    expect(nearestPaletteIndex(PALETTE, 0, 0, 0)).toBe(0);
    expect(nearestPaletteIndex(PALETTE, 255, 0, 0)).toBe(1);
    expect(nearestPaletteIndex(PALETTE, 200, 30, 30)).toBe(1); // antialiased red edge
    expect(nearestPaletteIndex(PALETTE, 240, 240, 240)).toBe(2); // near-white
  });
});

describe("encodePalettePng", () => {
  it("round-trips a 4x3 image with valid chunk CRCs", async () => {
    const img = [
      [0, 0, 0], [255, 0, 0], [255, 255, 255], [200, 30, 30],   // row 0 -> 0,1,2,1
      [255, 255, 255], [0, 0, 0], [10, 10, 10], [255, 0, 0],    // row 1 -> 2,0,0,1
      [255, 0, 0], [255, 255, 255], [255, 255, 255], [0, 0, 0], // row 2 -> 1,2,2,0
    ];
    const png = await encodePalettePng(4, 3, pixels(img.map(([r, g, b]) => [r, g, b] as [number, number, number])), PALETTE);
    const decoded = await decodeIndexedPng(png);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(decoded.plte).toEqual([0, 0, 0, 255, 0, 0, 255, 255, 255]);
    expect(decoded.rows).toEqual([
      [0, 1, 2, 1],
      [2, 0, 0, 1],
      [1, 2, 2, 0],
    ]);
  });

  it("maps transparent pixels to the background (last palette entry)", async () => {
    const png = await encodePalettePng(2, 1, pixels([[255, 0, 0, 0], [0, 0, 0, 255]]), PALETTE);
    const decoded = await decodeIndexedPng(png);
    expect(decoded.rows).toEqual([[2, 0]]);
  });

  it("compresses a 192x192 line drawing far below the RGBA canvas encoding", async () => {
    // White field with a black diagonal, like a draw-tool stroke.
    const entries: [number, number, number][] = [];
    for (let y = 0; y < 192; y += 1) {
      for (let x = 0; x < 192; x += 1) entries.push(Math.abs(x - y) < 2 ? [0, 0, 0] : [255, 255, 255]);
    }
    const png = await encodePalettePng(192, 192, pixels(entries), PALETTE);
    // The 3-stroke canvas.toBlob PNG measured 6,560 bytes; a single-stroke indexed
    // encoding must be well under 2KB to make share-link fit plausible.
    expect(png.length).toBeLessThan(2048);
  });

  it("rejects bad inputs", async () => {
    await expect(encodePalettePng(0, 1, new Uint8Array(0), PALETTE)).rejects.toThrow(/no pixels/);
    await expect(encodePalettePng(2, 2, new Uint8Array(4), PALETTE)).rejects.toThrow(/do not match/);
    await expect(encodePalettePng(1, 1, new Uint8Array(4), [{ r: 0, g: 0, b: 0 }])).rejects.toThrow(/palette/);
  });
});
