import { describe, it, expect } from "vitest";
import { asDepthZ, depthParallaxFactor, DEPTH_MIN, DEPTH_MAX } from "../../src/state/depth";

// C6 Phase 2: pure-logic regression tests for the existing DepthZ
// contract (AWR-05 C4). Does not change DepthZ and does not introduce
// another depth representation.

describe("asDepthZ", () => {
  it("accepts the minimum value Z0", () => {
    expect(asDepthZ(DEPTH_MIN)).toBe(DEPTH_MIN);
  });

  it("accepts the maximum value Z60", () => {
    expect(asDepthZ(DEPTH_MAX)).toBe(DEPTH_MAX);
  });

  it("accepts a valid integer in the middle of the range", () => {
    expect(asDepthZ(30)).toBe(30);
  });

  it("rejects a value below the minimum", () => {
    expect(() => asDepthZ(DEPTH_MIN - 1)).toThrow(RangeError);
  });

  it("rejects a value above the maximum", () => {
    expect(() => asDepthZ(DEPTH_MAX + 1)).toThrow(RangeError);
  });

  it("rejects a non-integer value", () => {
    expect(() => asDepthZ(30.5)).toThrow(RangeError);
  });
});

describe("depthParallaxFactor", () => {
  it("returns 0.25 for depth below 20", () => {
    expect(depthParallaxFactor(asDepthZ(0))).toBe(0.25);
    expect(depthParallaxFactor(asDepthZ(19))).toBe(0.25);
  });

  it("returns 0.6 for depth in [20, 40)", () => {
    expect(depthParallaxFactor(asDepthZ(20))).toBe(0.6);
    expect(depthParallaxFactor(asDepthZ(39))).toBe(0.6);
  });

  it("returns 1.0 for depth >= 40", () => {
    expect(depthParallaxFactor(asDepthZ(40))).toBe(1.0);
    expect(depthParallaxFactor(asDepthZ(60))).toBe(1.0);
  });
});
