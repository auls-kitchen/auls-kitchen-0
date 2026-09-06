import type { OrderingState } from "./types";
import type { AppEvent } from "../events/types";

// Ordering's own reducer — the ONLY place OrderingState is allowed to
// change. It never imports WorldState, never imports PixiJS, never
// imports the DOM, and never mutates anything outside the OrderingState
// it returns. main.ts calls this alongside (not instead of) World's own
// `reduce()` for every event on the shared bus; each reducer ignores
// event types it does not own via the default case, exactly like the
// existing World reducer already does.
export function reduceOrdering(state: OrderingState, event: AppEvent): OrderingState {
  switch (event.type) {
    case "MENU_INTENT":
      return { status: "requested", rejectionReason: null };
    case "ORDERING_READY":
      return { status: "ready", rejectionReason: null };
    case "ORDERING_REJECTED":
      return { status: "rejected", rejectionReason: event.reason };
    case "RETURN_TO_WORLD":
      return { status: "idle", rejectionReason: null };
    default:
      return state;
  }
}
