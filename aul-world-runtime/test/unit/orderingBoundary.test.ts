import { describe, it, expect } from "vitest";
import { decideOrderingOutcome } from "../../src/ordering/orderingBoundary";

// C6 Phase 2: pure-logic regression tests for the existing
// decideOrderingOutcome() boundary function only. Does not redesign
// the boundary and does not create an alternate implementation.

describe("decideOrderingOutcome", () => {
  it("returns ORDERING_READY when forceReject is false", () => {
    const result = decideOrderingOutcome({ type: "MENU_INTENT", source: "canvas", forceReject: false });
    expect(result).toEqual({ type: "ORDERING_READY" });
  });

  it("returns ORDERING_REJECTED with reason 'test_rejection' when forceReject is true", () => {
    const result = decideOrderingOutcome({ type: "MENU_INTENT", source: "dom", forceReject: true });
    expect(result).toEqual({ type: "ORDERING_REJECTED", reason: "test_rejection" });
  });
});
