// Experience shell view model (U3) - pure, DOM-free.
//
// The shell exposes its state as data-* attributes on one element. Those
// attributes are the presentation hooks the (later) real UI and the e2e tests
// read: the current interaction phase, which view a wake routed to, the
// Domain bootstrap status, and a read-only mirror of AWR's presentation.
//
// Nothing here decides anything. It maps values other modules already
// decided (a phase from the lifecycle, a route from the pending-ticket
// router) to attribute strings. In particular there is NO Domain action here,
// and no view can end a session, clear a cart, or retry an order.
//
// The shell never renders a previous customer's ticket: there is no ownership
// view and no pending-ticket attribute, and its last-Domain-event mirror is
// cleared whenever a customer boundary is presented (a wake, or Habitat).

import type { InteractionPhase, RestingPhase } from "../experience/interactionContext.ts";
import type { WakeDecision, WakeRoute } from "../experience/pendingTicket.ts";

// PRESENTATION views only - none of them is a Domain state.
// habitat     : no customer context is being served (boot, and after expiry)
// discover    : a customer has a fresh start
// waiting     : a customer woke the kiosk before the Domain was ready
// protected   : an unresolved submission exists; a neutral view, with no question
// unavailable : a previous context could not be shown as fresh; a neutral view,
//               distinct from waiting
export type ShellView = "habitat" | "discover" | "waiting" | "protected" | "unavailable";

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
    case "PROTECTED_NEUTRAL":
      return "protected";
    case "UNAVAILABLE_NEUTRAL":
      return "unavailable";
  }
}

export function initialShellState(domainStatus: string): ShellState {
  return Object.freeze({
    phase: "HABITAT_IDLE",
    view: "habitat",
    wakeRoute: "",
    domainStatus,
    domainLastEvent: "",
    world: Object.freeze({ presentationMode: "", camera: "", aulMood: "", aulInteractions: 0, frame: 0 }),
  });
}

// A customer's presented decision. The decision's diagnostic `pending` kind is NOT
// kept, and the last-Domain-event mirror is cleared: it is the previous context's
// activity, and must not carry across the boundary this presentation is.
export function withWake(state: ShellState, decision: WakeDecision): ShellState {
  return Object.freeze({ ...state, view: viewForRoute(decision.route), wakeRoute: decision.route, domainLastEvent: "" });
}

// Entering Habitat resets the Experience-only view state and the last-Domain-event
// mirror (the customer has left). It clears nothing in the Domain: the last wake
// route and the last event are dropped from the shell, that is all.
export function withHabitat(state: ShellState): ShellState {
  return Object.freeze({ ...state, view: "habitat", wakeRoute: "", domainLastEvent: "" });
}

// A customer's Home/X activation, as the shell hands it to the Composition:
// the phase the Experience was in BEFORE the press that started the gesture.
// It carries a phase name and nothing else - no Domain data, no handle.
export interface HomeRequest {
  readonly phaseBefore: RestingPhase;
}

// Structurally the lifecycle's latched press; the shell only needs its phase.
export type ConsumeGesture = () => HomeRequest | null | undefined;

// The Home/X activation gate - pure, DOM-free, and the shell's ONLY rule for
// turning a `click` into a request. It fails closed:
//   - an event that is not `isTrusted === true` (a script's .click() or a
//     dispatched click) does nothing, and does not even touch the latch;
//   - a trusted click with no latched press (nothing a customer pressed just
//     before it) does nothing;
//   - otherwise it consumes the latched press exactly once and returns only its
//     phase.
// It never reads or calls anything from the Domain.
export function resolveHomeActivation(event: { readonly isTrusted?: boolean } | null | undefined, consumeGesture: ConsumeGesture): HomeRequest | null {
  if (!event || event.isTrusted !== true) return null;
  let gesture: HomeRequest | null | undefined;
  try {
    gesture = consumeGesture();
  } catch {
    return null; // an unreadable latch is no latch
  }
  if (!gesture || typeof gesture.phaseBefore !== "string") return null;
  return Object.freeze({ phaseBefore: gesture.phaseBefore });
}

// The attribute map written to the shell element. Every value is a string;
// no field carries business data (no product, price, cart line, or identity).
export function shellAttributes(state: ShellState): Readonly<Record<string, string>> {
  return Object.freeze({
    "data-interaction-phase": state.phase,
    "data-view": state.view,
    "data-wake-route": state.wakeRoute,
    "data-domain-status": state.domainStatus,
    "data-domain-last-event": state.domainLastEvent,
    "data-world-presentation": state.world.presentationMode,
    "data-world-camera": state.world.camera,
    "data-aul-mood": state.world.aulMood,
    "data-aul-interactions": String(state.world.aulInteractions),
    "data-world-frame": String(state.world.frame),
  });
}
