import type { Bytes } from "./model";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Standard base64 with padding. Written out so no platform `btoa` is needed. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]!;
    out += i + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[chunk & 63]! : "=";
  }
  return out;
}

/** Throws a plain Error on any character outside the alphabet or a bad length. */
export function decodeBase64(text: string): Bytes {
  if (text.length % 4 !== 0) throw new Error("Invalid base64 length");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let i = 0; i < text.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4; j++) {
      const char = text[i + j]!;
      const isPad = char === "=" && i + j >= text.length - padding;
      const value = isPad ? 0 : LOOKUP.get(char);
      if (value === undefined) throw new Error("Invalid base64 character");
      chunk = (chunk << 6) | value;
    }
    for (const shift of [16, 8, 0]) {
      if (written < out.length) out[written++] = (chunk >> shift) & 255;
    }
  }
  return out;
}
