// Experience shell view model (U3) - pure, DOM-free.
//
// The shell exposes its state as data-* attributes on one element. Those
// attributes are the presentation hooks the (later) real UI and the e2e tests
// read: the current interaction phase, which view a wake routed to, the
// Domain bootstrap status, and a read-only mirror of AWR's presentation.
//
// Nothing here decides anything. It maps values other modules already
// decided (a phase from the lifecycle, a route from the pending-ticket
// router) to attribute strings. In particular there is NO Domain action here:
// the "ownership" view is an inert marker for the deferred U4 confirmation UI,
// and no view can end a session, clear a cart, or retry an order.

import type { InteractionPhase } from "../experience/interactionContext.ts";
import type { WakeDecision, WakeRoute } from "../experience/pendingTicket.ts";

// habitat    : no customer context is being served (boot, and after expiry)
// discover   : a customer woke the kiosk with no pending ticket
// ownership  : a customer woke the kiosk with a pending ticket (U4 will ask
//              "Hi Kak, ini pesanan Kakak, ya?"; inert until then)
// waiting    : a customer woke the kiosk before the Domain was ready
export type ShellView = "habitat" | "discover" | "ownership" | "waiting";

export interface WorldMirror {
  readonly presentationMode: string;
  readonly camera: string;
  readonly aulMood: string;
  readonly aulInteractions: number;
  readonly frame: number;
}

export interface ShellState {
  readonly phase: InteractionPhase;
  readonly view: ShellView;
  readonly wakeRoute: string;
  readonly pending: string;
  readonly domainStatus: string;
  readonly domainLastEvent: string;
  readonly world: WorldMirror;
}

export function viewForRoute(route: WakeRoute): ShellView {
  switch (route) {
    case "WAIT_NOT_READY":
      return "waiting";
    case "DISCOVER_MENU":
      return "discover";
    case "OWNERSHIP_CONFIRMATION":
      return "ownership";
  }
}

export function initialShellState(domainStatus: string): ShellState {
  return Object.freeze({
    phase: "HABITAT_IDLE",
    view: "habitat",
    wakeRoute: "",
    pending: "",
    domainStatus,
    domainLastEvent: "",
    world: Object.freeze({ presentationMode: "", camera: "", aulMood: "", aulInteractions: 0, frame: 0 }),
  });
}

export function withWake(state: ShellState, decision: WakeDecision): ShellState {
  return Object.freeze({ ...state, view: viewForRoute(decision.route), wakeRoute: decision.route, pending: decision.pending });
}

// Entering Habitat resets the Experience-only view state. It clears nothing in
// the Domain: the last wake route is dropped from the shell, that is all.
export function withHabitat(state: ShellState): ShellState {
  return Object.freeze({ ...state, view: "habitat", wakeRoute: "", pending: "" });
}

// The attribute map written to the shell element. Every value is a string;
// no field carries business data (no product, price, cart line, or identity).
export function shellAttributes(state: ShellState): Readonly<Record<string, string>> {
  return Object.freeze({
    "data-interaction-phase": state.phase,
    "data-view": state.view,
    "data-wake-route": state.wakeRoute,
    "data-pending": state.pending,
    "data-domain-status": state.domainStatus,
    "data-domain-last-event": state.domainLastEvent,
    "data-world-presentation": state.world.presentationMode,
    "data-world-camera": state.world.camera,
    "data-aul-mood": state.world.aulMood,
    "data-aul-interactions": String(state.world.aulInteractions),
    "data-world-frame": String(state.world.frame),
  });
}
