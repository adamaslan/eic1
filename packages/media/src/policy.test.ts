import { describe, expect, it } from "vitest";
import { fitWithin, reductionPercent } from "./policy";

describe("fitWithin", () => {
  it("keeps images that already fit", () => {
    expect(fitWithin({ width: 800, height: 600 }, 1920)).toEqual({ width: 800, height: 600 });
  });

  it("scales the longest side down and keeps the aspect ratio", () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 1920)).toEqual({ width: 1920, height: 1440 });
    expect(fitWithin({ width: 3000, height: 4000 }, 1920)).toEqual({ width: 1440, height: 1920 });
  });

  it("never returns a zero-sized side", () => {
    expect(fitWithin({ width: 10000, height: 2 }, 320)).toEqual({ width: 320, height: 1 });
  });
});

describe("reductionPercent", () => {
  it("rounds to a whole percent", () => {
    expect(reductionPercent(1000, 250)).toBe(75);
    expect(reductionPercent(3, 2)).toBe(33);
  });

  it("is 0 when nothing was saved or input is empty", () => {
    expect(reductionPercent(100, 100)).toBe(0);
    expect(reductionPercent(100, 150)).toBe(0);
    expect(reductionPercent(0, 0)).toBe(0);
  });
});
