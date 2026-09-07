// RT-11 Phase 2: "Ordering2" — a genuinely different, independently
// written second implementation of the existing Ordering contract
// (see ./types.ts's OrderingImplementation), used to empirically test
// whether World can evolve independently of Ordering's internal
// implementation.
//
// This file does NOT import, call, wrap, delegate to, or otherwise
// reuse ./reducer.ts or ./orderingBoundary.ts (Ordering1) in any way —
// verified by inspection: the only imports below are type-only
// imports of the shared public contract (OrderingState, OrderingStatus,
// AppEvent, MenuIntentEvent), never a value import of Ordering1's
// functions.
//
// Architectural difference from Ordering1 (disclosed, not incidental):
// - reduceOrdering (Ordering1) is a flat `switch (event.type)`.
//   reduceOrderingAlt (here) is a state-indexed, then event-indexed,
//   declarative lookup table: `TRANSITION_TABLE[state.status]?.[event.type]`.
//   This is a materially different control-flow/decomposition strategy,
//   not a rename or reformatting of the switch statement.
// - decideOrderingOutcome (Ordering1) is a single `if/else` boolean
//   branch. decideOrderingOutcomeAlt (here) is an ordered, data-driven
//   rule list evaluated first-match-wins. This is a materially
//   different decision representation, not a renamed if/else.
//
// Both functions are inert in the running application until Phase 4
// wires an opt-in selection point into main.ts — this file makes no
// change to default runtime behavior on its own.

import type { OrderingState, OrderingStatus } from "./types";
import type { AppEvent, MenuIntentEvent } from "../events/types";

type Transition = (event: AppEvent) => OrderingState;

// Ordering1's own reducer is state-independent (verified by direct
// inspection of ./reducer.ts): each of these four event types always
// produces the same resulting status regardless of the current status.
// This table is built once, then reused for every OrderingStatus key,
// to faithfully reproduce that same state-independence through a
// state-indexed lookup rather than a flat switch — not four
// hand-duplicated copies of the same four cases.
const HANDLERS_FOR_ANY_STATE: Partial<Record<AppEvent["type"], Transition>> = {
  MENU_INTENT: () => ({ status: "requested", rejectionReason: null }),
  ORDERING_READY: () => ({ status: "ready", rejectionReason: null }),
  ORDERING_REJECTED: (event) => ({
    status: "rejected",
    rejectionReason: (event as Extract<AppEvent, { type: "ORDERING_REJECTED" }>).reason,
  }),
  RETURN_TO_WORLD: () => ({ status: "idle", rejectionReason: null }),
};

const TRANSITION_TABLE: Record<OrderingStatus, Partial<Record<AppEvent["type"], Transition>>> = {
  idle: HANDLERS_FOR_ANY_STATE,
  requested: HANDLERS_FOR_ANY_STATE,
  ready: HANDLERS_FOR_ANY_STATE,
  rejected: HANDLERS_FOR_ANY_STATE,
};

export function reduceOrderingAlt(state: OrderingState, event: AppEvent): OrderingState {
  const handler = TRANSITION_TABLE[state.status]?.[event.type];
  return handler ? handler(event) : state;
}

interface OutcomeRule {
  when: (event: MenuIntentEvent) => boolean;
  outcome: (event: MenuIntentEvent) => AppEvent;
}

const OUTCOME_RULES: OutcomeRule[] = [
  {
    when: (event) => event.forceReject === true,
    outcome: () => ({ type: "ORDERING_REJECTED", reason: "test_rejection" }),
  },
  {
    when: () => true,
    outcome: () => ({ type: "ORDERING_READY" }),
  },
];

export function decideOrderingOutcomeAlt(event: MenuIntentEvent): AppEvent {
  const rule = OUTCOME_RULES.find((r) => r.when(event))!;
  return rule.outcome(event);
}
