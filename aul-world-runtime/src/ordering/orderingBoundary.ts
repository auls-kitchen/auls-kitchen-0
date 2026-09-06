// The Ordering side of the World <-> Ordering boundary decision. This is
// deliberately NOT a reducer (reducers stay pure state-in/state-out) —
// it is a pure event-in/event-out function, analogous in spirit to
// AWR-02's effect layer, except this proof requires no external system
// and no asynchronous boundary (Section 10/6 of the AWR-03 blueprint:
// no real catalog/cart/payment, no network). main.ts calls this exactly
// once, when it observes a MENU_INTENT event, and emits whatever it
// returns straight back onto the shared bus.
import type { MenuIntentEvent, AppEvent } from "../events/types";

export function decideOrderingOutcome(event: MenuIntentEvent): AppEvent {
  if (event.forceReject) {
    return { type: "ORDERING_REJECTED", reason: "test_rejection" };
  }
  return { type: "ORDERING_READY" };
}
