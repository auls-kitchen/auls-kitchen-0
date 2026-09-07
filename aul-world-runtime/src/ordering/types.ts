// Ordering's own state, deliberately kept entirely separate from
// state/types.ts (WorldState). This is the AWR-03 proof: World and
// Ordering are two independent domains sharing only the semantic event
// bus, never each other's state shape. This file has no import of
// WorldState, no import of PixiJS, no import of the DOM, and no
// reference to a real catalog/cart/payment model — it is intentionally
// the smallest state that can distinguish the four required phases.

export type OrderingStatus = "idle" | "requested" | "ready" | "rejected";

export interface OrderingState {
  status: OrderingStatus;
  rejectionReason: string | null;
}

export function createInitialOrderingState(): OrderingState {
  return { status: "idle", rejectionReason: null };
}

// RT-11: names the de facto contract reduceOrdering()/decideOrderingOutcome()
// already had, without changing either function. Purely descriptive —
// erased at compile time, zero runtime footprint.
export interface OrderingImplementation {
  reduceOrdering: (state: OrderingState, event: import("../events/types").AppEvent) => OrderingState;
  decideOrderingOutcome: (event: import("../events/types").MenuIntentEvent) => import("../events/types").AppEvent;
}

// RT-11 Phase 2: compile-time proof that BOTH the existing Ordering1
// implementation and the new, independently-written Ordering2
// implementation (./orderingAlt.ts) satisfy the same OrderingImplementation
// contract. This composition lives here — not inside orderingAlt.ts,
// which must not import Ordering1 — because reducer.ts/orderingBoundary.ts
// only import *types* from this module (erased at compile time), so this
// file importing their runtime functions creates no runtime circular
// dependency. Neither export below is wired into main.ts yet (that is
// Phase 4); they exist solely to keep this contract compiler-checked
// starting now, without modifying reducer.ts or orderingBoundary.ts.
import { reduceOrdering } from "./reducer";
import { decideOrderingOutcome } from "./orderingBoundary";
import { reduceOrderingAlt, decideOrderingOutcomeAlt } from "./orderingAlt";

export const ordering1Contract = { reduceOrdering, decideOrderingOutcome } satisfies OrderingImplementation;
export const orderingAltContract = {
  reduceOrdering: reduceOrderingAlt,
  decideOrderingOutcome: decideOrderingOutcomeAlt,
} satisfies OrderingImplementation;
