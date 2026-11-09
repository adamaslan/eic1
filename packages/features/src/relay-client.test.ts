import { describe, expect, it, vi } from "vitest";
import { createRelayTransport, relayEndpoint } from "./relay-client";
import type { RelayReadRequest } from "./relay-adapter";
const request: RelayReadRequest = { pubkey: "public", feedPath: "feeds/x", ts: 1, nonce: "nonce", signature: "sig" };
describe("endpoint-bound relay HTTP client", () => {
  it("rejects credentials, fragments, insecure remote origins and query strings", () => {
    for (const value of ["https://user:pass@eic.example/relay", "http://eic.example/relay", "https://eic.example/#x", "https://eic.example/?x"]) expect(() => relayEndpoint(value)).toThrow();
  });
  it("uses only configured endpoint without cookies or redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ manifest: "signed" })));
    expect(await createRelayTransport("https://eic.example/relay/", fetcher).read(request)).toEqual({ manifest: "signed" });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eic.example/relay/read"); expect(options.credentials).toBe("omit"); expect(options.redirect).toBe("error"); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body as string)).toEqual(request);
  });
  it("rejects oversized streamed replies and unexpected responses", async () => {
    for (const response of [new Response("x".repeat(2 * 1024 * 1024 + 1)), new Response("{}"), new Response("failed", { status: 503 })]) {
      await expect(createRelayTransport("https://eic.example", async () => response).read(request)).rejects.toThrow();
    }
  });
});
