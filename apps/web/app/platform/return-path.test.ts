import { describe, expect, it } from "vitest";
import { returnPath } from "./return-path";

describe("returnPath", () => {
  it("returns the screen that asked for the unlock, with its query and fragment", () => {
    expect(returnPath({ from: "/item/abc?x=1#y" })).toBe("/item/abc?x=1#y");
  });

  it.each([null, undefined, {}, { from: 7 }, { from: "feed" }, { from: "//evil.example" }, { from: "https://evil.example" }, { from: "/unlock" }])(
    "falls back to home for %j",
    (state) => {
      expect(returnPath(state)).toBe("/");
    },
  );
});
