import { describe, expect, it, vi } from "vitest";

// While EIC_BACKUP_SYNC is unset the function must answer 404 and never resolve the blob client.
vi.mock("@netlify/blobs", () => {
  throw new Error("@netlify/blobs is not installed in this environment");
});

import apiBackup from "../api-backup.ts";

describe("gated backup function with the blob client unresolvable", () => {
  it.each(["GET", "PUT", "DELETE"])("%s /api/backup answers 404 while OFF", async (method) => {
    const res = await apiBackup(new Request("https://test.local/api/backup", { method, body: method === "PUT" ? "{}" : undefined }));
    expect(res.status).toBe(404);
  });
});
