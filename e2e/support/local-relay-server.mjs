/**
 * Local stand-in for the Netlify share relay, for e2e runs against `react-router dev`.
 * It imports the SAME share-core.ts the deployed functions wrap, so the flow under test
 * is the flow that ships - only the blob store is swapped for an in-memory map.
 *
 * Env: PORT (default 4180), APP_ORIGIN (default http://localhost:5173 - the "Open in
 * eic" deep link target; in production app and relay share one origin).
 */
import http from "node:http";
import {
  createShare,
  deleteShare,
  extractPhoto,
  readShare,
  renderMissingPage,
  renderSharePage,
  ShareError,
} from "../../netlify/functions/share-core.ts";

const PORT = Number(process.env.PORT ?? 4180);
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";

const entries = new Map();
const store = {
  put: async (key, body, meta) => {
    entries.set(key, { body, meta });
  },
  get: async (key) => entries.get(key) ?? null,
  delete: async (key) => {
    entries.delete(key);
  },
  list: async () => [...entries.keys()],
};

// The e2e app origin (:5173) differs from the relay origin (:4180); production is
// same-origin and needs none of this. Local-only permissive CORS keeps the test honest.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-delete-key",
};

const json = (res, status, payload) => {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const relayBase = `http://localhost:${PORT}`;
  const bases = { relayBase, appBase: APP_ORIGIN };
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const apiMatch = /^\/api\/share\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && url.pathname === "/api/share") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const created = await createShare(store, Buffer.concat(chunks).toString("utf8"), new Date(), req.socket.remoteAddress ?? "local");
      json(res, 201, created);
      return;
    }
    if (req.method === "GET" && apiMatch) {
      const entry = await readShare(store, apiMatch[1], new Date());
      if (!entry) {
        json(res, 404, { error: "That shared post is no longer available." });
        return;
      }
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      res.end(entry.body);
      return;
    }
    if (req.method === "DELETE" && apiMatch) {
      const outcome = await deleteShare(store, apiMatch[1], req.headers["x-delete-key"] ?? "");
      if (outcome === "missing") json(res, 404, { error: "That shared post is no longer available." });
      else if (outcome === "forbidden") json(res, 403, { error: "That delete key does not match." });
      else {
        res.writeHead(204, CORS);
        res.end();
      }
      return;
    }
    const photoMatch = /^\/s\/([^/]+)\/photo$/.exec(url.pathname);
    const pageMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
    const id = (photoMatch ?? pageMatch)?.[1];
    if (req.method === "GET" && id) {
      const entry = await readShare(store, id, new Date());
      if (!entry) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(renderMissingPage(bases));
        return;
      }
      if (photoMatch) {
        const photo = extractPhoto(entry.body);
        if (!photo) {
          res.writeHead(404);
          res.end("No photo.");
          return;
        }
        res.writeHead(200, { "content-type": photo.mime });
        res.end(photo.bytes);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderSharePage(entry.body, id, bases));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (caught) {
    if (caught instanceof ShareError) {
      json(res, caught.status, { error: caught.message });
      return;
    }
    json(res, 500, { error: "The share service hit an error." });
  }
});

server.listen(PORT, () => {
  console.log(`local share relay on http://localhost:${PORT} (app origin ${APP_ORIGIN})`);
});
