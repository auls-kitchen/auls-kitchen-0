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
