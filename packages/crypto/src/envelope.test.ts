import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { generateSigningKeyPair } from "./signing";
import {
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  openSyncEnvelope,
  sealSyncEnvelope,
  type SyncEnvelope,
} from "./envelope";

async function author() {
  const keys = await generateSigningKeyPair();
  return { ...keys, id: `author-${encodeBase64(keys.publicKey).slice(0, 8)}` };
}

const BODY = new TextEncoder().encode("hey - pull this when you are on wifi 📡");

describe("ed25519 -> x25519 conversion", () => {
  it("derives the same shared secret on both sides", async () => {
    const a = await author();
    const b = await author();
    const aSecret = await ed25519SecretKeyToX25519(a.secretKey);
    const bSecret = await ed25519SecretKeyToX25519(b.secretKey);
    const aPublic = ed25519PublicKeyToX25519(a.publicKey);
    const bPublic = ed25519PublicKeyToX25519(b.publicKey);
    const ab = x25519.getSharedSecret(aSecret, bPublic);
    const ba = x25519.getSharedSecret(bSecret, aPublic);
    expect(encodeBase64(ab)).toBe(encodeBase64(ba));
  });

  it("rejects a malformed public key", () => {
    expect(() => ed25519PublicKeyToX25519(new Uint8Array(16))).toThrow("32 bytes");
  });

  it("rejects a secret that is not an Ed25519 PKCS8 key", async () => {
    await expect(ed25519SecretKeyToX25519(new Uint8Array(48))).rejects.toThrow("PKCS8");
  });
});

describe("eic-sync v1 envelopes", () => {
  it("round trips a chat envelope between two author identities", async () => {
    const a = await author();
    const b = await author();
    const envelope = await sealSyncEnvelope({
      secretKey: a.secretKey,
      authorId: a.id,
      recipientAuthorId: b.id,
      recipientPublicKey: b.publicKey,
      kind: "chat",
      plaintext: BODY,
    });
    expect(envelope.format).toBe("eic-sync");
    expect(envelope.version).toBe(1);
    // The wire form carries no plaintext.
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain("hey - pull this");
    const opened = await openSyncEnvelope({
      secretKey: b.secretKey,
      authorId: b.id,
      authorPublicKey: a.publicKey,
      envelope: JSON.parse(wire),
    });
    expect(opened.authorId).toBe(a.id);
    expect(opened.kind).toBe("chat");
    expect(new TextDecoder().decode(opened.plaintext)).toBe(new TextDecoder().decode(BODY));
  });

  it("rejects a tampered ciphertext", async () => {
    const a = await author();
    const b = await author();
    const envelope = await sealSyncEnvelope({
      secretKey: a.secretKey, authorId: a.id, recipientAuthorId: b.id,
      recipientPublicKey: b.publicKey, kind: "chat", plaintext: BODY,
    });
    const tampered: SyncEnvelope = { ...envelope, ciphertext: encodeBase64(decodeBase64(envelope.ciphertext).map((x, i) => (i === 0 ? x ^ 1 : x))) };
    await expect(openSyncEnvelope({ secretKey: b.secretKey, authorId: b.id, authorPublicKey: a.publicKey, envelope: tampered })).rejects.toThrow();
  });

  it("rejects an envelope signed by a different key", async () => {
    const a = await author();
    const b = await author();
    const eve = await author();
    const envelope = await sealSyncEnvelope({
      secretKey: a.secretKey, authorId: a.id, recipientAuthorId: b.id,
      recipientPublicKey: b.publicKey, kind: "likes", plaintext: BODY,
    });
    await expect(openSyncEnvelope({ secretKey: b.secretKey, authorId: b.id, authorPublicKey: eve.publicKey, envelope })).rejects.toThrow("signature");
  });

  it("rejects an envelope addressed to someone else", async () => {
    const a = await author();
    const b = await author();
    const c = await author();
    const envelope = await sealSyncEnvelope({
      secretKey: a.secretKey, authorId: a.id, recipientAuthorId: b.id,
      recipientPublicKey: b.publicKey, kind: "chat", plaintext: BODY,
    });
    await expect(openSyncEnvelope({ secretKey: c.secretKey, authorId: c.id, authorPublicKey: a.publicKey, envelope })).rejects.toThrow("addressed");
  });

  it("rejects damaged envelopes without leaking internals", async () => {
    const a = await author();
    const b = await author();
    await expect(openSyncEnvelope({ secretKey: b.secretKey, authorId: b.id, authorPublicKey: a.publicKey, envelope: null })).rejects.toThrow("eic-sync");
    await expect(openSyncEnvelope({ secretKey: b.secretKey, authorId: b.id, authorPublicKey: a.publicKey, envelope: { format: "eic-sync", version: 99 } })).rejects.toThrow("version");
    await expect(openSyncEnvelope({ secretKey: b.secretKey, authorId: b.id, authorPublicKey: a.publicKey, envelope: { format: "eic-sync", version: 1, authorId: a.id, recipientAuthorId: b.id, kind: "chat", nonce: "!!", ciphertext: "!!", signature: "!!" } })).rejects.toThrow("damaged");
  });
});
