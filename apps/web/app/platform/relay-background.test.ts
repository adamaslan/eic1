import { describe, expect, it } from "vitest";
import { relayPolicy, relayFeedConnections } from "./relay-background";

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

  it("never treats unknown as Wi-Fi: small data only, reported cellular needs the owner's opt-in", () => {
    expect(relayPolicy("wifi", false)).toEqual({ allowed: true, budgetBytes: null });
    expect(relayPolicy("unknown", false)).toEqual({ allowed: true, budgetBytes: 64 * 1024 });
    expect(relayPolicy("cellular", false).allowed).toBe(false);
    expect(relayPolicy("cellular", true)).toEqual({ allowed: true, budgetBytes: 1024 * 1024 });
    expect(relayPolicy("unknown", true)).toEqual({ allowed: true, budgetBytes: 1024 * 1024 });
  });
});
