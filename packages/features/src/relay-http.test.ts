import { describe, expect, it, vi } from "vitest";
import { createRelayHttpHandler, RELAY_HTTP_MAX_BYTES, type RelayHttpOptions } from "./relay-http";
import type { RelayAtomicStore } from "./relay-adapter";
const opts = (): RelayHttpOptions => ({ enabled: true, origins: ["https://eic.example"], keys: ["allowed-key"], maxPublishesPerWindow: 5, windowMs: 60000, now: () => new Date() });
function fixture(options = opts()) {
  const store: RelayAtomicStore = { get: vi.fn(), compareAndSet: vi.fn(), putObject: vi.fn(), list: vi.fn(), delete: vi.fn() };
  return { store, handle: createRelayHttpHandler(store, options) };
}
const req = (body = "{}", headers = { "content-type": "application/json", origin: "https://eic.example" }) => new Request("https://local.invalid/read", { method: "POST", headers, body });
function untouched(store: RelayAtomicStore) { for (const action of Object.values(store)) expect(action).not.toHaveBeenCalled(); }
describe("unwired signed relay HTTP boundary", () => {
  it("defaults OFF and empty allowlist fails closed without any store access", async () => {
    for (const options of [{ ...opts(), enabled: undefined }, { ...opts(), keys: [] }]) {
      const { handle, store } = fixture(options); expect((await handle(req())).status).toBe(503); untouched(store);
    }
  });
  it("rejects origins, wrong methods, paths and content type before store", async () => {
    const { handle, store } = fixture();
    expect((await handle(req("{}", { "content-type": "application/json", origin: "https://evil.invalid" }))).status).toBe(403);
    expect((await handle(new Request("https://local.invalid/read"))).status).toBe(405);
    expect((await handle(new Request("https://local.invalid/ack", { method: "POST" }))).status).toBe(404);
    expect((await handle(req("{}", { "content-type": "text/plain", origin: "https://eic.example" }))).status).toBe(415);
    untouched(store);
  });
  it("permits narrow CORS preflight, never credentials/wildcard origins", async () => {
    const { handle, store } = fixture();
    const response = await handle(new Request("https://local.invalid/read", { method: "OPTIONS", headers: { origin: "https://eic.example", "access-control-request-method": "POST" } }));
    expect(response.status).toBe(204); expect(response.headers.get("access-control-allow-origin")).toBe("https://eic.example");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull(); untouched(store);
  });
  it("bounds stream size regardless of content-length and rejects malformed input", async () => {
    const { handle, store } = fixture();
    for (const body of ["{" , JSON.stringify({ signature: "x".repeat(129) }), "x".repeat(RELAY_HTTP_MAX_BYTES + 1)]) expect((await handle(req(body))).status).toBe(400);
    const headers = { "content-type": "application/json", origin: "https://eic.example", "content-length": String(RELAY_HTTP_MAX_BYTES + 1) };
    expect((await handle(req("{}", headers))).status).toBe(400); untouched(store);
  });
  it("does not mistake caller origin or unconfigured key for authentication", async () => {
    const { handle, store } = fixture();
    const response = await handle(req(JSON.stringify({ pubkey: "unconfigured", signature: "x", feedPath: `feeds/${"a".repeat(52)}`, ts: Date.now(), nonce: "fresh" })));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("unconfigured"); untouched(store);
  });
  it("caps a streamed body with no usable content-length before the store", async () => {
    const { handle, store } = fixture();
    const part = new TextEncoder().encode("x".repeat(1024 * 1024));
    const body = new ReadableStream({ start(controller) { controller.enqueue(part); controller.enqueue(part); controller.enqueue(part); controller.close(); } });
    // undici requires duplex for stream bodies; the DOM RequestInit type predates it.
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { "content-type": "application/json", origin: "https://eic.example" }, body, duplex: "half" };
    const streamed = new Request("https://local.invalid/read", init);
    expect((await handle(streamed)).status).toBe(400); untouched(store);
  });
  it("snapshots allowlist and defaults rather than exposing mutable arrays", async () => {
    const options = opts(); const { handle, store } = fixture(options); options.origins.push("https://evil.invalid"); options.keys.length = 0;
    expect((await handle(req("{}", { "content-type": "application/json", origin: "https://evil.invalid" }))).status).toBe(403); untouched(store);
  });
});
