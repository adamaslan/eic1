/**
 * Encrypted backup sync API: PUT /api/backup, GET /api/backup, DELETE /api/backup, with the
 * owner's recovery secret in x-backup-secret. Inert unless EIC_BACKUP_SYNC=on (owner decision).
 */
import { BackupError, deleteBackup, getBackup, putBackup } from "./lib/backup-core.ts";
import type { ShareStore } from "./lib/share-core.ts";

// Lazy import: the blob client loads only after the gate below has passed.
const blobStore = async (): Promise<ShareStore> => {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "encrypted-backups", consistency: "strong" });
  return {
    put: async (key, body, meta, condition) => {
      const result = await store.set(key, body, { metadata: meta, onlyIfNew: condition?.onlyIfNew, onlyIfMatch: condition?.onlyIfMatch });
      return { modified: result.modified };
    },
    get: async (key) => {
      const found = await store.getWithMetadata(key, { type: "text" });
      if (!found || typeof found.data !== "string") return null;
      return { body: found.data, meta: (found.metadata ?? {}) as Record<string, string>, etag: found.etag };
    },
    delete: async (key) => {
      await store.delete(key);
    },
    list: async () => (await store.list()).blobs.map((blob) => blob.key),
  };
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const ENABLED = process.env.EIC_BACKUP_SYNC === "on";

interface RequestContext {
  ip?: string;
}

export default async (request: Request, context?: RequestContext): Promise<Response> => {
  if (!ENABLED) return json(404, { error: "Backup sync is not enabled on this deployment." });
  const secret = request.headers.get("x-backup-secret");
  const client = context?.ip ?? request.headers.get("x-nf-client-connection-ip") ?? "unknown";
  try {
    const store = await blobStore();
    if (request.method === "PUT") return json(200, { ...(await putBackup(store, secret, await request.text(), new Date(), client)) });
    if (request.method === "GET") {
      const body = await getBackup(store, secret, new Date());
      return body === null ? json(404, { error: "No backup found." }) : new Response(body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (request.method === "DELETE") {
      const outcome = await deleteBackup(store, secret);
      return outcome === "missing" ? json(404, { error: "No backup found." }) : new Response(null, { status: 204 });
    }
    return json(405, { error: "Method not allowed." });
  } catch (caught) {
    if (caught instanceof BackupError) return json(caught.status, { error: caught.message });
    return json(500, { error: "The backup service hit an error." });
  }
};

export const config = { path: "/api/backup" };
