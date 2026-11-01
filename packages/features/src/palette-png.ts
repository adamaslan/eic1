import { AppError } from "@veil/core";

// Indexed (palette) PNG encoder for the draw tool. The canvas only ever holds the 16
// Win95 palette colors on a white background, so an 8-bit indexed PNG (color type 3)
// keeps every stroke crisp while shrinking a 192px drawing from ~6.5KB RGBA to
// roughly 1-2KB - small enough that a drawing can fit inside a share-one-post link.
// Antialiased edge pixels snap to their nearest palette color, which matches the
// chunky old-Paint look. No dependencies: CRC32 by table, zlib via CompressionStream.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") throw new AppError("This browser could not encode the drawing.");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Index of the palette color nearest to (r, g, b). Ties go to the earlier color. */
export function nearestPaletteIndex(palette: readonly Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const dr = palette[i].r - r;
    const dg = palette[i].g - g;
    const db = palette[i].b - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Encodes RGBA pixels as an 8-bit indexed PNG. Every pixel is mapped to its nearest
 * palette color; pixels with alpha under 128 map to the palette's last entry (which
 * callers set to the background, white for the draw tool).
 */
export async function encodePalettePng(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  palette: readonly Rgb[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (width < 1 || height < 1) throw new AppError("The drawing has no pixels.");
  if (palette.length < 2 || palette.length > 256) throw new AppError("The drawing palette is invalid.");
  if (rgba.length !== width * height * 4) throw new AppError("The drawing pixels do not match its size.");

  // One scanline = filter byte (0) + one palette index per pixel.
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      raw[rowStart + 1 + x] =
        rgba[p + 3] < 128
          ? palette.length - 1
          : nearestPaletteIndex(palette, rgba[p], rgba[p + 1], rgba[p + 2]);
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((color, i) => {
    plte[i * 3] = color.r;
    plte[i * 3 + 1] = color.g;
    plte[i * 3 + 2] = color.b;
  });

  const idat = await deflate(raw);
  const png = new Uint8Array(8 + ihdr.length + 12 + plte.length + 12 + idat.length + 12 + 12);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let offset = 8;
  for (const part of [chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
