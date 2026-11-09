import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { loadOrCreateShareIdentity } from "@veil/features";
import { verifySignature } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import {
  dropSharedLink,
  finalizePublishedShare,
  loadSharedLink,
  loadSharedLinks,
  publishSharedPost,
  publishSharedPostFlow,
  retainShareIntent,
  revokeSharedPost,
  type SharedLinkRef,
} from "./share-relay";

const fakeVault = (): UnlockedVault & { records: Map<string, unknown> } => {
  const records = new Map<string, unknown>();
  return {
    records,
    getJson: async (id: string) => records.get(id) ?? null,
    putJson: async (_namespace: string, id: string, value: unknown) => {
      records.set(id, value);
    },
    listJson: async (_kind: string) => [...records.values()],
    deleteRecords: async (ids: string[]) => {
      for (const id of ids) records.delete(id);
    },
  } as unknown as UnlockedVault & { records: Map<string, unknown> };
};

const ref = (id: string, postId = "post-1"): SharedLinkRef => ({
  id,
  url: `https://eic.example/s/${id}`,
  deleteKey: `key-${id}`,
  postId,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("shared link refs", () => {
  it("keeps every published link as its own record, newest last", async () => {
    const vault = fakeVault();
    await vault.putJson("identity", "eic.sharedLink.a", ref("a"));
    await vault.putJson("identity", "eic.sharedLink.b", ref("b"));
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect((await loadSharedLink(vault, "post-1"))?.id).toBe("b");
  });

  it("migrates the legacy map record into per-link records on first read", async () => {
    const vault = fakeVault();
    await vault.putJson("identity", "eic.sharedLinks.v1", { links: { "post-1": [ref("a"), ref("b")] } });
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(await vault.getJson("eic.sharedLinks.v1")).toBeNull();
    expect(await vault.getJson("eic.sharedLink.a")).toMatchObject({ id: "a", pending: false });
  });

  it("drops one ref by id and keeps the rest; drops the post when none remain", async () => {
    const vault = fakeVault();
    await vault.putJson("identity", "eic.sharedLink.a", ref("a"));
    await vault.putJson("identity", "eic.sharedLink.b", ref("b"));
    await dropSharedLink(vault, "post-1", "b");
    expect((await loadSharedLinks(vault, "post-1")).map((entry) => entry.id)).toEqual(["a"]);
    await dropSharedLink(vault, "post-1");
    expect(await loadSharedLinks(vault, "post-1")).toEqual([]);
  });
});

describe("publish intent retention", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  const bundle = () => JSON.stringify({ format: "eic-share", version: 2, author: { handle: "t", pubkey: "x" }, posts: [] });

  it("persists the intent BEFORE publishing, then marks it confirmed", async () => {
    const vault = fakeVault();
    await loadOrCreateShareIdentity(vault);
    let seenId: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenId = String(init?.headers && new Headers(init.headers).get("x-share-id"));
        // The intent must already be in the vault when the request is sent.
        expect(await vault.getJson(`eic.sharedLink.${seenId}`)).toMatchObject({ id: seenId, pending: true });
        return new Response(JSON.stringify({ id: seenId, deleteKey: "k".repeat(32) }), { status: 201 });
      })
    );
    const outcome = await publishSharedPostFlow(vault, bundle(), "post-1");
    expect(outcome.ref.pending).toBe(false);
    expect((await loadSharedLink(vault, "post-1"))?.pending).toBeFalsy();
    expect((await loadSharedLink(vault, "post-1"))?.id).toBe(seenId);
  });

  it("a lost response keeps the pending intent; the retry reuses the same id and key", async () => {
    const vault = fakeVault();
    await loadOrCreateShareIdentity(vault);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const id = String(new Headers(init?.headers).get("x-share-id"));
        const key = String(new Headers(init?.headers).get("x-delete-key"));
        seen.push(`${id}:${key}`);
        if (seen.length === 1) throw new Error("network down"); // response lost after commit
        return new Response(JSON.stringify({ id, deleteKey: key, existed: true }), { status: 200 });
      })
    );
    await expect(publishSharedPostFlow(vault, bundle(), "post-1")).rejects.toThrow("may already be live");
    const pending = await loadSharedLink(vault, "post-1");
    expect(pending?.pending).toBe(true);
    const retry = await publishSharedPostFlow(vault, bundle(), "post-1");
    expect(retry.ref.id).toBe(pending!.id);
    expect(retry.ref.pending).toBe(false);
    expect(seen[0]).toBe(seen[1]); // same id + same key: the retry is an idempotent no-op server-side
  });

  it("a refused retry keeps its delete key because an earlier attempt may have committed", async () => {
    const vault = fakeVault();
    await loadOrCreateShareIdentity(vault);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "The share service is full right now. Try again later." }), { status: 503 })));
    await expect(publishSharedPostFlow(vault, bundle(), "post-1")).rejects.toThrow("full");
    expect((await loadSharedLink(vault, "post-1"))?.pending).toBe(true);
  });

  it("finalize failure keeps the pending ref, which still revokes the live link", async () => {
    const vault = fakeVault();
    await loadOrCreateShareIdentity(vault);
    const intent = await retainShareIntent(vault, "post-1");
    vault.putJson = async () => {
      throw new Error("vault busy");
    };
    await finalizePublishedShare(vault, intent).catch(() => undefined);
    expect((await loadSharedLink(vault, "post-1"))?.pending).toBe(true);
  });
});

describe("publishSharedPost proof", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the provision and a proof binding digest, timestamp, id and delete-key hash", async () => {
    const vault = fakeVault();
    const identity = await loadOrCreateShareIdentity(vault);
    const bundle = JSON.stringify({
      format: "eic-share",
      version: 2,
      author: { handle: "tester", pubkey: encodeBase64(identity.publicKey) },
      posts: [],
    });
    const provision = { id: "abc123def456abcd", deleteKey: "k".repeat(32) };
    let captured: { url: string; headers: Headers; body: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(input), headers: new Headers(init?.headers), body: String(init?.body) };
        return new Response(JSON.stringify({ id: provision.id, deleteKey: provision.deleteKey, existed: false }), { status: 201 });
      })
    );

    const published = await publishSharedPost(vault, bundle, provision);
    expect(published).toEqual({ id: provision.id, url: `${globalThis.location?.origin ?? ""}/s/${provision.id}`, deleteKey: provision.deleteKey, existed: false });
    expect(captured!.url).toBe("/api/share");
    expect(captured!.headers.get("x-share-id")).toBe(provision.id);
    expect(captured!.headers.get("x-delete-key")).toBe(provision.deleteKey);
    expect(captured!.headers.get("x-share-proof-id")).toBe(provision.id);
    // The exact check the relay runs: signature over "v1\n<digest>\n<at>\n<id>\n<keyHash>".
    const at = captured!.headers.get("x-share-proof-at")!;
    const digest = createHash("sha256").update(captured!.body).digest("hex");
    const keyDigest = createHash("sha256").update(provision.deleteKey).digest("hex");
    const payload = new TextEncoder().encode(`eic-share-publish:v1\n${digest}\n${at}\n${provision.id}\n${keyDigest}`);
    expect(await verifySignature(identity.publicKey, payload, decodeBase64(captured!.headers.get("x-share-proof")!))).toBe(true);
  });

  it("rejects a response naming a different id than the provisioned one", async () => {
    const vault = fakeVault();
    await loadOrCreateShareIdentity(vault);
    const bundle = JSON.stringify({ format: "eic-share", version: 2, author: { handle: "t", pubkey: "x" }, posts: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "someoneelsesid1", deleteKey: "k".repeat(32) }), { status: 201 }))
    );
    await expect(publishSharedPost(vault, bundle, { id: "abc123def456abcd", deleteKey: "k".repeat(32) })).rejects.toThrow("unexpected");
  });

  it("revoke treats a 404 as already gone but surfaces other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(revokeSharedPost("abc123", "key")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    await expect(revokeSharedPost("abc123", "key")).rejects.toThrow("boom");
  });
});

it.each([409,500,503])("retains revocation keys after ambiguous HTTP %s", async (status) => {
  const vault = fakeVault(); await loadOrCreateShareIdentity(vault);
  const before = await retainShareIntent(vault, "post-1");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "refused" }), { status })));
  await expect(publishSharedPostFlow(vault, "{}", "post-1")).rejects.toThrow();
  expect((await loadSharedLink(vault, "post-1"))?.deleteKey).toBe(before.deleteKey);
  vi.unstubAllGlobals();
});

it("keeps an expired link revocable but starts a fresh intent next time", async () => {
  const vault = fakeVault(); await loadOrCreateShareIdentity(vault);
  const before = await retainShareIntent(vault, "post-1");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "expired" }), { status: 410 })));
  await expect(publishSharedPostFlow(vault, "{}", "post-1")).rejects.toThrow();
  const refs = await loadSharedLinks(vault, "post-1");
  expect(refs.find((r) => r.id === before.id)?.deleteKey).toBe(before.deleteKey);
  const next = await retainShareIntent(vault, "post-1");
  expect(next.id).not.toBe(before.id);
  vi.unstubAllGlobals();
});
