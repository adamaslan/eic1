import { describe, expect, it } from "vitest";
import { relayAllowed, relayFeedConnections } from "./relay-background";

const ENDPOINT = "https://relay.example";
const conn = (id: string, feedUrl: string | null, pubkey: string | null = "pk") => ({ id, feedUrl, pubkey }) as never;

describe("background relay selection", () => {
  it("only pulls friends whose feed lives on this relay, with a verified key", () => {
    const picked = relayFeedConnections([
      conn("on-relay", `${ENDPOINT}/feeds/abc`),
      conn("legacy-file", "https://other.example/feeds/abc"),
      conn("no-key", `${ENDPOINT}/feeds/abc`, null),
      conn("no-feed", null),
    ], ENDPOINT);
    expect(picked.map((c) => c.id)).toEqual(["on-relay"]);
  });

  it("uses cellular only when the owner allowed it", () => {
    expect(relayAllowed("wifi", false)).toBe(true);
    expect(relayAllowed("cellular", false)).toBe(false);
    expect(relayAllowed("unknown", false)).toBe(false);
    expect(relayAllowed("cellular", true)).toBe(true);
  });
});
