/**
 * Share page: GET /s/<id> renders the readable post (this is also what iMessage's
 * preview crawler reads - og:title/description/image come from the shared post itself),
 * GET /s/<id>/photo serves the photo bytes.
 */
import { extractPhoto, readShare, renderMissingPage, renderSharePage, type ShareStore } from "./lib/share-core.ts";

// Lazy import, same contract as api-share: no @netlify/blobs resolution before the gate.
const blobStore = async (): Promise<ShareStore> => {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("shared-posts");
  return {
    put: async () => {
      throw new Error("read-only surface");
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

// Same hard gate as api-share: gated deployments render the missing page, never content.
const ENABLED = process.env.EIC_SHARE_RELAY === "on";

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const origin = url.origin;
  const bases = { relayBase: origin, appBase: origin };
  if (!ENABLED) {
    return new Response(renderMissingPage(bases), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const photoMatch = /^\/s\/([^/]+)\/photo$/.exec(url.pathname);
  const pageMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
  const id = (photoMatch ?? pageMatch)?.[1];
  if (request.method !== "GET" || !id) {
    return new Response(renderMissingPage(bases), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const entry = await readShare(await blobStore(), id, new Date());
  if (!entry) {
    return new Response(renderMissingPage(bases), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (photoMatch) {
    const photo = extractPhoto(entry.body);
    if (!photo) return new Response("No photo.", { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      status: 200,
      headers: { "content-type": photo.mime, "cache-control": "public, max-age=300, must-revalidate" },
    });
  }
  return new Response(renderSharePage(entry.body, id, bases), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60, must-revalidate" },
  });
};

export const config = { path: "/s/*" };
