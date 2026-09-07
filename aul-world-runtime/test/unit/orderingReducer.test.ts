import { describe, it, expect } from "vitest";
import { reduceOrdering } from "../../src/ordering/reducer";
import { createInitialOrderingState } from "../../src/ordering/types";
import type { AppEvent } from "../../src/events/types";

// C6 Phase 2: pure-logic regression tests for ordering/reducer.ts —
// the existing, single Ordering implementation only. Does not create a
// second Ordering implementation and does not exercise RT-11.

describe("reduceOrdering", () => {
  it("starts idle with no rejection reason", () => {
    const state = createInitialOrderingState();
    expect(state).toEqual({ status: "idle", rejectionReason: null });
  });

  it("MENU_INTENT transitions to requested and clears any rejection reason", () => {
    const state = createInitialOrderingState();
    const next = reduceOrdering(state, { type: "MENU_INTENT", source: "canvas", forceReject: false });
    expect(next).toEqual({ status: "requested", rejectionReason: null });
  });

  it("ORDERING_READY transitions to ready", () => {
    const state = reduceOrdering(createInitialOrderingState(), { type: "MENU_INTENT", source: "canvas", forceReject: false });
    const next = reduceOrdering(state, { type: "ORDERING_READY" });
    expect(next).toEqual({ status: "ready", rejectionReason: null });
  });

  it("ORDERING_REJECTED transitions to rejected and carries the reason", () => {
    const state = reduceOrdering(createInitialOrderingState(), { type: "MENU_INTENT", source: "canvas", forceReject: true });
    const next = reduceOrdering(state, { type: "ORDERING_REJECTED", reason: "test_rejection" });
    expect(next).toEqual({ status: "rejected", rejectionReason: "test_rejection" });
  });

  it("RETURN_TO_WORLD resets back to idle regardless of prior status", () => {
    const ready = reduceOrdering(createInitialOrderingState(), { type: "ORDERING_READY" });
    const next = reduceOrdering(ready, { type: "RETURN_TO_WORLD", source: "dom" });
    expect(next).toEqual({ status: "idle", rejectionReason: null });
  });

  it("ignores event types it does not own, returning the exact same state reference", () => {
    const state = createInitialOrderingState();
    const next = reduceOrdering(state, { type: "TICK", deltaMs: 16 } as AppEvent);
    expect(next).toBe(state);
  });
});
