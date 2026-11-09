import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks(); });
it("returns sanitized JSON when an enabled blob client fails to start", async () => {
  vi.stubEnv("EIC_SHARE_RELAY", "on");
  vi.doMock("@netlify/blobs", () => ({ getStore: () => { throw new Error("secret-store-detail"); } }));
  const { default: handle } = await import("../api-share.ts");
  const response = await handle(new Request("https://eic.example/api/share", { method: "POST", body: "{}" }));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret-store-detail");
});
it("marks enabled shared photo responses as nosniff", async () => {
  vi.stubEnv("EIC_SHARE_RELAY", "on");
  vi.doMock("../lib/share-core.ts", () => ({
    readShare: vi.fn().mockResolvedValue({ body: "signed-fixture" }),
    extractPhoto: vi.fn().mockReturnValue({ bytes: new Uint8Array([1]), mime: "image/png" }),
    renderMissingPage: vi.fn().mockReturnValue("missing"), renderSharePage: vi.fn().mockReturnValue("post"),
  }));
  vi.doMock("@netlify/blobs", () => ({ getStore: () => ({}) }));
  const { default: handle } = await import("../page.ts");
  const response = await handle(new Request("https://eic.example/s/abcdefghijklmnop/photo"));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

it("returns sanitized unavailable text when shared-page storage fails", async () => {
  vi.stubEnv("EIC_SHARE_RELAY", "on");
  vi.doMock("@netlify/blobs", () => ({ getStore: () => { throw new Error("private-backend-detail"); } }));
  const { default: handle } = await import("../page.ts");
  const response = await handle(new Request("https://eic.example/s/abcdefghijklmnop"));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("private-backend-detail");
});
