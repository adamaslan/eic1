/**
 * Share relay API: publish (POST /api/share), fetch (GET /api/share/:id) and revoke
 * (DELETE /api/share/:id with the creator's delete key in x-delete-key).
 */
import { createShare, deleteShare, readShare, ShareError, type ShareStore } from "./lib/share-core.ts";

// Lazy import: the blob client loads only after the ENABLED gate below has passed, so a
// gated deployment never resolves @netlify/blobs at cold start and stays truly inert.
const blobStore = async (): Promise<ShareStore> => {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("shared-posts");
  return {
    put: async (key, body, meta) => {
      await store.set(key, body, { metadata: meta });
    },
    get: async (key) => {
      const found = await store.getWithMetadata(key, { type: "text" });
      if (!found || typeof found.data !== "string") return null;
      return { body: found.data, meta: (found.metadata ?? {}) as Record<string, string> };
    },
    delete: async (key) => {
      await store.delete(key);
    },
    list: async () => (await store.list()).blobs.map((blob) => blob.key),
  };
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

// Hard gate: the relay stays inert until the owner sets EIC_SHARE_RELAY=on (scoped to
// production) in the Netlify site env. Deploy previews build the functions but every
// route answers 404 and nothing is ever written to the blob store while gated.
const ENABLED = process.env.EIC_SHARE_RELAY === "on";

interface RequestContext {
  ip?: string;
}

export default async (request: Request, context?: RequestContext): Promise<Response> => {
  if (!ENABLED) return json(404, { error: "Link sharing is not enabled on this deployment." });
  const url = new URL(request.url);
  // Path after the redirect: /api/share or /api/share/<id>
  const idMatch = /^\/api\/share\/([^/]+)$/.exec(url.pathname);
  const store = await blobStore();
  try {
    if (request.method === "POST" && url.pathname === "/api/share") {
      const body = await request.text();
      const created = await createShare(store, body, new Date(), context?.ip ?? request.headers.get("x-nf-client-connection-ip") ?? "unknown");
      return json(201, created);
    }
    if (request.method === "GET" && idMatch) {
      const entry = await readShare(store, idMatch[1], new Date());
      if (!entry) return json(404, { error: "That shared post is no longer available." });
      return new Response(entry.body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method === "DELETE" && idMatch) {
      const key = request.headers.get("x-delete-key") ?? "";
      const outcome = await deleteShare(store, idMatch[1], key);
      if (outcome === "missing") return json(404, { error: "That shared post is no longer available." });
      if (outcome === "forbidden") return json(403, { error: "That delete key does not match." });
      return new Response(null, { status: 204 });
    }
    return json(405, { error: "Method not allowed." });
  } catch (caught) {
    if (caught instanceof ShareError) return json(caught.status, { error: caught.message });
    return json(500, { error: "The share service hit an error." });
  }
};

export const config = { path: ["/api/share", "/api/share/*"] };
