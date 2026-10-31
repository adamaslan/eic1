import { describe, expect, it } from "vitest";
import { buildPostShareLink, readPostShareLink, POST_LINK_PREFIX, MAX_POST_LINK_CHARS } from "./share-link";

const BASE = "https://everybodyiscool.netlify.app/";

describe("share-one-post links", () => {
  it("round-trips a bundle through a link, unicode included", () => {
    const bundle = JSON.stringify({ format: "eic-share", version: 1, title: "Bikes 🚲 & café" });
    const link = buildPostShareLink(bundle, BASE);
    expect(link.startsWith(`${BASE}${POST_LINK_PREFIX}`)).toBe(true);
    expect(readPostShareLink(new URL(link).hash)).toBe(bundle);
  });

  it("carries the post only after the fragment, never in the URL path", () => {
    const bundle = JSON.stringify({ title: "secret title words" });
    const link = buildPostShareLink(bundle, BASE);
    expect(link.split("#")[0]).not.toContain("secret");
    expect(link.split("#")[0]).toBe(BASE);
  });

  it("ignores hashes that are not share links", () => {
    expect(readPostShareLink("")).toBeNull();
    expect(readPostShareLink("#/feed")).toBeNull();
    expect(readPostShareLink("#imported=abc")).toBeNull();
  });

  it("rejects oversized posts with a clear message", () => {
    const huge = "x".repeat(MAX_POST_LINK_CHARS);
    expect(() => buildPostShareLink(huge, BASE)).toThrow(/too big for a link/);
  });

  it("reports damaged links instead of crashing", () => {
    expect(() => readPostShareLink(`${POST_LINK_PREFIX}!!!not-base64!!!`)).toThrow(/damaged/);
  });
});
