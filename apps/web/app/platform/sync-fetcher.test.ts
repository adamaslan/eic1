import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSyncNetwork, httpSyncFetcher } from "./sync-fetcher";

describe("httpSyncFetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends If-None-Match when an etag is known and maps status/etag/text", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("hello", { status: 200, headers: { etag: '"v2"' } });
    });
    const res = await httpSyncFetcher("https://friend.example/feed/manifest.json", '"v1"');
    expect((calls[0].headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
    expect(res).toEqual({ status: 200, etag: '"v2"', text: "hello" });
  });

  it("omits the conditional header and body on first fetch / 304", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 304 }));
    const res = await httpSyncFetcher("https://friend.example/feed/manifest.json", null);
    expect(res).toEqual({ status: 304, etag: null, text: null });
  });
});

describe("detectSyncNetwork", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats unknown connectivity as cellular (wi-fi-only default)", () => {
    vi.stubGlobal("navigator", {});
    expect(detectSyncNetwork()).toBe("cellular");
  });

  it("reports wifi only for explicit wifi/ethernet transport", () => {
    vi.stubGlobal("navigator", { connection: { type: "wifi" } });
    expect(detectSyncNetwork()).toBe("wifi");
    vi.stubGlobal("navigator", { connection: { type: "ethernet" } });
    expect(detectSyncNetwork()).toBe("wifi");
    vi.stubGlobal("navigator", { connection: { type: "cellular" } });
    expect(detectSyncNetwork()).toBe("cellular");
    vi.stubGlobal("navigator", { connection: { type: "wifi", saveData: true } });
    expect(detectSyncNetwork()).toBe("cellular");
  });

  it("never treats effectiveType (speed estimate) as wifi", () => {
    vi.stubGlobal("navigator", { connection: { effectiveType: "4g" } });
    expect(detectSyncNetwork()).toBe("cellular");
  });
});
