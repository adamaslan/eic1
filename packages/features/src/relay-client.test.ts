import { describe, expect, it, vi } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { configureRelayFeed, createRelayTransport, relayEndpoint } from "./relay-client";
import { defaultSettings, loadSettings, saveSettings } from "./social";
import type { RelayReadRequest } from "./relay-adapter";
const request: RelayReadRequest = { pubkey: "public", feedPath: "feeds/x", ts: 1, nonce: "nonce", signature: "sig" };
describe("endpoint-bound relay HTTP client", () => {
  it("allows plain http for IPv4 and IPv6 loopback only", () => {
    for (const value of ["http://localhost:5174/r", "http://127.0.0.1:54321/r", "http://[::1]:54321/r"]) expect(() => relayEndpoint(value)).not.toThrow();
    expect(() => relayEndpoint("http://[::2]:54321/r")).toThrow();
  });
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

describe("configureRelayFeed", () => {
  const openVault = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date("2026-10-30T12:00:00Z") }, "pass phrase 1");

  it("patches only feedUrl: a concurrent editor's field survives relay setup", async () => {
    const vault = await openVault();
    await saveSettings(vault, { ...defaultSettings(), authorId: "a1", handle: "h1" });
    // Interleave an editor's handle write between relay setup's settings read and its
    // CAS attempt; setup must retry and still keep the editor's field.
    let collided = false;
    const racing: UnlockedVault = {
      ...vault,
      putJsonIfUnchanged: async (kind, id, value, expected) => {
        if (!collided && kind === "settings") {
          collided = true;
          const current = (await vault.getJson(id)) as Record<string, unknown>;
          await vault.putJsonIfUnchanged(kind, id, { ...current, handle: "edited-during-setup" }, current);
        }
        return vault.putJsonIfUnchanged(kind, id, value, expected);
      },
    };
    const { feedUrl } = await configureRelayFeed(racing, "https://eic.example/relay");
    expect(collided).toBe(true);
    expect(feedUrl.startsWith("https://eic.example/relay/")).toBe(true);
    const persisted = await loadSettings(vault);
    expect(persisted.feedUrl).toBe(feedUrl);
    expect(persisted.handle).toBe("edited-during-setup");
  });
});
