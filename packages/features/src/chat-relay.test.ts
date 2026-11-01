import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import {
  base32Lower,
  publisherPath,
  verifyRelayPublish,
  RELAY_MAX_CHUNK_BYTES,
  RELAY_MAX_FILES_PER_PUBLISH,
} from "./chat-relay";
import { FEED_FORMAT, FEED_VERSION } from "./feed";

async function sha256Base64(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return encodeBase64(new Uint8Array(digest));
}

async function signedPublish(opts?: { kind?: string; tamper?: boolean }) {
  const key = await generateSigningKeyPair();
  const chunk = JSON.stringify({ format: "eic-feed-chunk", version: 1, kind: "chat", envelopes: [] });
  const unsigned = {
    format: FEED_FORMAT,
    version: FEED_VERSION,
    authorId: "author-1",
    feedUrl: "https://relay.example/feeds/x",
    pubkey: encodeBase64(key.publicKey),
    seq: 1,
    builtAt: new Date("2026-10-31T00:00:00Z").toISOString(),
    chunks: [
      {
        id: "chat-peer.json",
        kind: opts?.kind ?? "chat",
        bytes: new TextEncoder().encode(chunk).byteLength,
        sha256: await sha256Base64(chunk),
      },
    ],
  };
  const signature = await signPayload(key.secretKey, new TextEncoder().encode(JSON.stringify(unsigned)));
  const manifest = JSON.stringify({ ...unsigned, signature: encodeBase64(signature) });
  return {
    key,
    request: {
      manifest: opts?.tamper ? manifest.replace('"seq":1', '"seq":2') : manifest,
      files: [
        { path: "feed.json", text: manifest },
        { path: "chunks/chat-peer.json", text: chunk },
      ],
    },
  };
}

describe("verifyRelayPublish", () => {
  it("accepts a well-formed chat-only publish and binds the path to the key", async () => {
    const { key, request } = await signedPublish();
    const result = await verifyRelayPublish(request);
    expect(result.publisherPath).toBe(await publisherPath(encodeBase64(key.publicKey)));
    expect(result.publisherPath).toMatch(/^feeds\/[a-z2-7]{52}$/);
    expect(result.seq).toBe(1);
    expect(result.files).toHaveLength(2);
  });

  it("rejects a tampered manifest (signature mismatch)", async () => {
    const { request } = await signedPublish({ tamper: true });
    await expect(verifyRelayPublish(request)).rejects.toThrow(/signature does not check out|damaged/);
  });

  it("rejects non-chat chunks so plaintext posts/profile never enter the relay", async () => {
    const { request } = await signedPublish({ kind: "posts" });
    await expect(verifyRelayPublish(request)).rejects.toThrow(/does not store posts, likes, or profile/);
  });

  it("rejects files the manifest does not pin", async () => {
    const { request } = await signedPublish();
    request.files.push({ path: "chunks/extra.json", text: "{}" });
    await expect(verifyRelayPublish(request)).rejects.toThrow(/does not pin/);
  });

  it("rejects a chunk whose bytes differ from the pinned hash", async () => {
    const { request } = await signedPublish();
    request.files[1].text += " ";
    await expect(verifyRelayPublish(request)).rejects.toThrow(/does not match the signed manifest/);
  });

  it("rejects a missing pinned chunk", async () => {
    const { request } = await signedPublish();
    request.files.pop();
    await expect(verifyRelayPublish(request)).rejects.toThrow(/missing files/);
  });

  it("enforces the allowlist when provided", async () => {
    const { request } = await signedPublish();
    await expect(verifyRelayPublish(request, { allowlist: [encodeBase64(new Uint8Array(32))] })).rejects.toThrow(/not on the allowlist/);
    const { key, request: ok } = await signedPublish();
    await expect(verifyRelayPublish(ok, { allowlist: [encodeBase64(key.publicKey)] })).resolves.toBeTruthy();
  });

  it("bounds file count and chunk size", async () => {
    const { request } = await signedPublish();
    const many = { ...request, files: Array.from({ length: RELAY_MAX_FILES_PER_PUBLISH + 1 }, (_, i) => ({ path: `f${i}`, text: "" })) };
    await expect(verifyRelayPublish(many)).rejects.toThrow(/too many files/);
    expect(RELAY_MAX_CHUNK_BYTES).toBe(1024 * 1024);
  });
});

describe("base32Lower", () => {
  it("encodes RFC4648 lowercase without padding", () => {
    expect(base32Lower(new Uint8Array([0xff]))).toBe("74");
    expect(base32Lower(new Uint8Array([]))).toBe("");
  });
});
