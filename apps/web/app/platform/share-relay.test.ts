import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { loadOrCreateShareIdentity } from "@veil/features";
import { verifySignature } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import {
  dropSharedLink,
  loadSharedLink,
  loadSharedLinks,
  publishSharedPost,
  revokeSharedPost,
  saveSharedLink,
  type SharedLinkRef,
} from "./share-relay";

const fakeVault = (): UnlockedVault => {
  const records = new Map<string, unknown>();
  return {
    getJson: async (id: string) => records.get(id) ?? null,
    putJson: async (_namespace: string, id: string, value: unknown) => {
      records.set(id, value);
    },
  } as unknown as UnlockedVault;
};

const ref = (id: string, postId = "post-1"): SharedLinkRef => ({
  id,
  url: `https://eic.example/s/${id}`,
  deleteKey: `key-${id}`,
  postId,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("shared link refs", () => {
  it("keeps every published link per post, newest last - a delete key is never overwritten away", async () => {
    const vault = fakeVault();
    await saveSharedLink(vault, ref("a"));
    await saveSharedLink(vault, ref("b"));
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect((await loadSharedLink(vault, "post-1"))?.id).toBe("b");
  });

  it("reads a legacy single-ref record as a one-element list", async () => {
    const vault = fakeVault();
    await vault.putJson("identity", "eic.sharedLinks.v1", { links: { "post-1": ref("a") } });
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("drops one ref by id and keeps the rest; drops the post when none remain", async () => {
    const vault = fakeVault();
    await saveSharedLink(vault, ref("a"));
    await saveSharedLink(vault, ref("b"));
    await dropSharedLink(vault, "post-1", "b");
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a"]);
    await dropSharedLink(vault, "post-1", "a");
    expect(await loadSharedLink(vault, "post-1")).toBeNull();
    await saveSharedLink(vault, ref("c"));
    await dropSharedLink(vault, "post-1");
    expect(await loadSharedLinks(vault, "post-1")).toEqual([]);
  });
});

describe("publishSharedPost proof", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a fresh-owner-intent proof the relay can verify against the bundle author key", async () => {
    const vault = fakeVault();
    const identity = await loadOrCreateShareIdentity(vault);
    const bundle = JSON.stringify({
      format: "eic-share",
      version: 2,
      author: { handle: "tester", pubkey: encodeBase64(identity.publicKey) },
      posts: [],
    });
    let captured: { url: string; headers: Headers; body: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(input), headers: new Headers(init?.headers), body: String(init?.body) };
        return new Response(JSON.stringify({ id: "abc123", deleteKey: "k".repeat(32) }), { status: 201 });
      })
    );

    const published = await publishSharedPost(vault, bundle);
    expect(published).toEqual({ id: "abc123", url: `${globalThis.location?.origin ?? ""}/s/abc123`, deleteKey: "k".repeat(32) });
    expect(captured!.url).toBe("/api/share");
    // The exact check the relay runs: signature over "eic-share-publish:v1\n<sha256hex>\n<at>".
    const at = captured!.headers.get("x-share-proof-at")!;
    const digest = createHash("sha256").update(captured!.body).digest("hex");
    const payload = new TextEncoder().encode(`eic-share-publish:v1\n${digest}\n${at}`);
    const ok = await verifySignature(identity.publicKey, payload, decodeBase64(captured!.headers.get("x-share-proof")!));
    expect(ok).toBe(true);
  });

  it("revoke treats a 404 as already gone but surfaces other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(revokeSharedPost("abc123", "key")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    await expect(revokeSharedPost("abc123", "key")).rejects.toThrow("boom");
  });
});
