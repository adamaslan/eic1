// Store-only ZIP writer/reader (compression method 0). MP3s barely compress, so a stored
// container keeps bundles byte-exact with no dependency. Writer emits data descriptors: no.
// All offsets are computed up front, which is fine at the bundle sizes we cap (100MB).

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const METHOD_STORE = 0;
/** One stored entry must fit a 32-bit size field; the bundle cap keeps us far below it. */
const MAX_ENTRIES = 1000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function zipCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function dosDateTime(now: Date): { time: number; date: number } {
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

/** Builds a ZIP archive with every entry stored uncompressed. Throws on bad input. */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error("A bundle needs between 1 and 1000 files.");
  const encoder = new TextEncoder();
  const names = entries.map((e) => {
    if (!e.name || e.name.includes("\\") || e.name.startsWith("/") || e.name.includes("..")) {
      throw new Error(`Unsafe bundle file name: ${e.name}`);
    }
    return encoder.encode(e.name);
  });
  const { time, date } = dosDateTime(now);
  const crcs = entries.map((e) => zipCrc32(e.data));

  let total = 22; // end record
  entries.forEach((e, i) => {
    if (e.data.length > 0xffffffff) throw new Error(`File too large for a bundle: ${e.name}`);
    total += 30 + names[i]!.length + e.data.length + 46 + names[i]!.length;
  });
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const centralOffsets: number[] = [];

  entries.forEach((entry, i) => {
    centralOffsets.push(offset);
    view.setUint32(offset, LOCAL_SIG, true);
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, METHOD_STORE, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, crcs[i]!, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, names[i]!.length, true);
    view.setUint16(offset + 28, 0, true); // no extra field
    out.set(names[i]!, offset + 30);
    out.set(entry.data, offset + 30 + names[i]!.length);
    offset += 30 + names[i]!.length + entry.data.length;
  });

  const centralStart = offset;
  entries.forEach((entry, i) => {
    view.setUint32(offset, CENTRAL_SIG, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, METHOD_STORE, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, crcs[i]!, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, names[i]!.length, true);
    // extra, comment, disk, internal attrs all 0
    view.setUint32(offset + 38, 0, true); // external attrs
    view.setUint32(offset + 42, centralOffsets[i]!, true);
    out.set(names[i]!, offset + 46);
    offset += 46 + names[i]!.length;
  });

  view.setUint32(offset, END_SIG, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // no comment
  return out;
}

/** Reads the entries out of a ZIP archive. Only stored (method 0) entries are accepted. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new Error("That file is too small to be a bundle.");
  // Find the end-of-central-directory record (no comment is written by us, but scan anyway).
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That file is not a readable bundle.");
  const count = view.getUint16(end + 10, true);
  if (count > MAX_ENTRIES) throw new Error("That bundle has too many files.");
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) throw new Error("That bundle is damaged.");
    const method = view.getUint16(offset + 10, true);
    if (method !== METHOD_STORE) throw new Error("That bundle uses compression eic cannot read.");
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    // Read the data from the local header, whose extra field can differ in length.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    if (data.length !== size || zipCrc32(data) !== crc) throw new Error(`Damaged file in bundle: ${name}`);
    entries.push({ name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
