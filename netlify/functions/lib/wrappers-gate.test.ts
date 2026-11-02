import { describe, expect, it, vi } from "vitest";

// Negative control for the cold-start failure Netlify hit: if either wrapper statically
// imported @netlify/blobs, this module graph would throw at import time below.
vi.mock("@netlify/blobs", () => {
  throw new Error("@netlify/blobs is not installed in this environment");
});

import apiShare from "../api-share.ts";
import sharePage from "../page.ts";

describe("gated wrappers with the blob client unresolvable", () => {
  it("POST /api/share answers 404 and never touches the blob client while OFF", async () => {
    const res = await apiShare(new Request("https://test.local/api/share", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
  it("GET /api/share/:id answers 404 while OFF", async () => {
    const res = await apiShare(new Request("https://test.local/api/share/abc"));
    expect(res.status).toBe(404);
  });
  it("GET /s/:id answers 404 while OFF", async () => {
    const res = await sharePage(new Request("https://test.local/s/abc"));
    expect(res.status).toBe(404);
  });
  it("GET /s/:id/photo answers 404 while OFF", async () => {
    const res = await sharePage(new Request("https://test.local/s/abc/photo"));
    expect(res.status).toBe(404);
  });
});
