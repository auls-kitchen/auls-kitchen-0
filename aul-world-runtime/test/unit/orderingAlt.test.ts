import { describe, it, expect } from "vitest";
import { reduceOrderingAlt, decideOrderingOutcomeAlt } from "../../src/ordering/orderingAlt";
import { reduceOrdering } from "../../src/ordering/reducer";
import { decideOrderingOutcome } from "../../src/ordering/orderingBoundary";
import type { OrderingState, OrderingStatus } from "../../src/ordering/types";
import type { AppEvent, MenuIntentEvent } from "../../src/events/types";

// RT-11 Phase 3: unit verification of Ordering2 (orderingAlt.ts) in
// isolation, plus explicit equivalence tests against Ordering1
// (reducer.ts / orderingBoundary.ts). Ordering1's own test files
// (orderingReducer.test.ts, orderingBoundary.test.ts) are unmodified.

const ALL_STATUSES: OrderingStatus[] = ["idle", "requested", "ready", "rejected"];

function stateAt(status: OrderingStatus): OrderingState {
  // rejected states carry a prior reason to prove transitions do not
  // depend on incidental leftover data from before the event.
  return { status, rejectionReason: status === "rejected" ? "prior_reason" : null };
}

const OWNED_EVENTS: AppEvent[] = [
  { type: "MENU_INTENT", source: "canvas", forceReject: false },
  { type: "ORDERING_READY" },
  { type: "ORDERING_REJECTED", reason: "test_rejection" },
  { type: "RETURN_TO_WORLD", source: "dom" },
];

describe("reduceOrderingAlt: owned events from every OrderingStatus", () => {
  for (const status of ALL_STATUSES) {
    for (const event of OWNED_EVENTS) {
      it(`${event.type} from status=${status}`, () => {
        const result = reduceOrderingAlt(stateAt(status), event);
        if (event.type === "MENU_INTENT") {
          expect(result).toEqual({ status: "requested", rejectionReason: null });
        } else if (event.type === "ORDERING_READY") {
          expect(result).toEqual({ status: "ready", rejectionReason: null });
        } else if (event.type === "ORDERING_REJECTED") {
          expect(result).toEqual({ status: "rejected", rejectionReason: "test_rejection" });
        } else if (event.type === "RETURN_TO_WORLD") {
          expect(result).toEqual({ status: "idle", rejectionReason: null });
        }
      });
    }
  }
});

describe("reduceOrderingAlt: unrelated event pass-through", () => {
  for (const status of ALL_STATUSES) {
    it(`TICK from status=${status} returns the exact same state reference`, () => {
      const state = stateAt(status);
      const result = reduceOrderingAlt(state, { type: "TICK", deltaMs: 16 });
      expect(result).toBe(state);
    });
  }
});

describe("decideOrderingOutcomeAlt", () => {
  it("forceReject=true -> ORDERING_REJECTED with reason 'test_rejection'", () => {
    const event: MenuIntentEvent = { type: "MENU_INTENT", source: "canvas", forceReject: true };
    expect(decideOrderingOutcomeAlt(event)).toEqual({ type: "ORDERING_REJECTED", reason: "test_rejection" });
  });

  it("forceReject=false -> ORDERING_READY", () => {
    const event: MenuIntentEvent = { type: "MENU_INTENT", source: "dom", forceReject: false };
    expect(decideOrderingOutcomeAlt(event)).toEqual({ type: "ORDERING_READY" });
  });
});

describe("RT-11 equivalence: reduceOrderingAlt vs reduceOrdering (Ordering1)", () => {
  for (const status of ALL_STATUSES) {
    for (const event of OWNED_EVENTS) {
      it(`${event.type} from status=${status} produces an identical OrderingState`, () => {
        const alt = reduceOrderingAlt(stateAt(status), event);
        const original = reduceOrdering(stateAt(status), event);
        expect(alt).toEqual(original);
      });
    }

    it(`unrelated event (TICK) from status=${status} produces an identical OrderingState`, () => {
      const alt = reduceOrderingAlt(stateAt(status), { type: "TICK", deltaMs: 16 });
      const original = reduceOrdering(stateAt(status), { type: "TICK", deltaMs: 16 });
      expect(alt).toEqual(original);
    });
  }
});

describe("RT-11 equivalence: decideOrderingOutcomeAlt vs decideOrderingOutcome (Ordering1)", () => {
  it("forceReject=true produces an identical AppEvent", () => {
    const event: MenuIntentEvent = { type: "MENU_INTENT", source: "canvas", forceReject: true };
    expect(decideOrderingOutcomeAlt(event)).toEqual(decideOrderingOutcome(event));
  });

  it("forceReject=false produces an identical AppEvent", () => {
    const event: MenuIntentEvent = { type: "MENU_INTENT", source: "dom", forceReject: false };
    expect(decideOrderingOutcomeAlt(event)).toEqual(decideOrderingOutcome(event));
  });
});
