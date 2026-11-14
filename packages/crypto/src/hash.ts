import { sha256 } from "@noble/hashes/sha2.js";

/** Lowercase hex SHA-256 of a UTF-8 string, for deterministic local record ids. */
export function sha256Hex(text: string): string {
  const digest = sha256(new TextEncoder().encode(text));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
