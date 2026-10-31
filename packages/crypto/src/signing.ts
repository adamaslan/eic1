import type { Bytes } from "@veil/core";

// Ed25519 signing over the Web Crypto API (browsers, Node 22+). Keys are extractable so the
// vault can seal them like any other secret; the raw secret bytes never leave the encrypted store.
const ALGO = "Ed25519";

export interface SigningKeyPair {
  publicKey: Bytes;
  secretKey: Bytes;
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: ALGO }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  const secretKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey, secretKey };
}

export async function signPayload(secretKey: Bytes, payload: Bytes): Promise<Bytes> {
  const key = await globalThis.crypto.subtle.importKey("pkcs8", secretKey, { name: ALGO }, false, ["sign"]);
  return new Uint8Array(await globalThis.crypto.subtle.sign({ name: ALGO }, key, payload));
}

export async function verifySignature(publicKey: Bytes, payload: Bytes, signature: Bytes): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", publicKey, { name: ALGO }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify({ name: ALGO }, key, signature, payload);
  } catch {
    return false;
  }
}
