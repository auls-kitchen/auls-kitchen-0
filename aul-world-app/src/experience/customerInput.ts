// Customer-input adapter (U2) - the only place raw DOM events become
// "the customer touched the kiosk".
//
// It receives exactly two things: an EventTarget to listen on, and an
// InputSink. It has no reference to the timer, the Domain, the AWR bus, or
// any callback other than sink.noteCustomerInput(). Nothing but this adapter
// is ever given the sink, so customer input is the only wake/reset authority.
//
// What counts as customer input (approved):
//   - pointerdown            a touch/click anywhere on the target, including
//                            empty canvas and decoration (the AWR bus cannot
//                            see those, which is why input is read from the DOM)
//   - pointermove            ONLY while pressed (buttons > 0): a drag/swipe.
//                            Hover (buttons === 0) is NOT input.
//   - touchmove              a finger dragging, incl. a pan after the browser
//                            has taken the gesture over from pointer events
//   - wheel                  a physical scroll wheel / trackpad
//   - keydown                ONLY Enter or Space, not auto-repeat, on an
//                            interactive element (an explicit kiosk action)
//
// What never counts:
//   - any event with isTrusted !== true: a synthetic dispatchEvent from page
//     script is never customer input
//   - hover, focus, `scroll`, timers, AWR TICK, and anything else not listed
//
// `scroll` is deliberately NOT listened to. The browser fires `scroll` (as a
// trusted event) for programmatic scrolling and momentum/layout shifts too, so
// it cannot tell a customer from the system. Real scroll gestures are already
// covered by pointerdown / pressed pointermove / touchmove / wheel / keydown.
//
// Text-entry keys are not counted in this unit: how the shell captures a name
// or note is not decided yet, and the predicate below is injectable.
//
// The adapter never consumes an event: listeners are passive, run in the
// capture phase, and never call preventDefault or stopPropagation - so the
// touch that wakes the kiosk still reaches, and activates, its own target.
//
// All listeners are bound to ONE AbortController signal; dispose() aborts it,
// removing every listener at once. dispose() is idempotent.

import type { CustomerInputKind, InputSink } from "../contracts.ts";

// The structural shape of a DOM event this module reads. A real DOM Event
// (Pointer/Touch/Wheel/Keyboard) is assignable to it; tests pass plain objects.
export interface CustomerInputEventLike {
  readonly type: string;
  readonly isTrusted?: boolean;
  readonly buttons?: number;
  readonly key?: string;
  readonly repeat?: boolean;
  readonly target?: unknown;
}

export type InteractiveTargetPredicate = (target: unknown) => boolean;

export interface CustomerInputOptions {
  // Decides whether a keydown landed on an interactive element. Defaults to a
  // duck-typed check; the Experience shell may supply a stricter one.
  readonly isInteractiveTarget?: InteractiveTargetPredicate;
}

export interface CustomerInputBinding {
  dispose(): void;
}

// The exact set of event types the adapter listens to.
export const CUSTOMER_INPUT_EVENT_TYPES = ["pointerdown", "pointermove", "touchmove", "wheel", "keydown"] as const;

const ACTIVATION_KEYS: readonly string[] = ["Enter", " ", "Spacebar"];
const INTERACTIVE_TAGS: readonly string[] = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"];
const INTERACTIVE_ROLES: readonly string[] = ["button", "link", "menuitem", "tab", "option", "checkbox", "radio", "switch"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Duck-typed so it works on real DOM elements without importing any DOM class.
export function isInteractiveElement(target: unknown): boolean {
  if (!isRecord(target)) return false;
  if (target.disabled === true) return false;

  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  // Called with the element as receiver: DOM getAttribute throws
  // "Illegal invocation" if detached from its element.
  const readAttribute = (name: string): unknown =>
    typeof target.getAttribute === "function" ? (target.getAttribute as (attribute: string) => unknown).call(target, name) : null;

  if (INTERACTIVE_TAGS.includes(tag)) return true;
  if (tag === "A") {
    const href = readAttribute("href");
    if (href !== null && href !== undefined) return true;
  }

  const role = readAttribute("role");
  return typeof role === "string" && INTERACTIVE_ROLES.includes(role);
}

// Pure classification: what kind of customer input is this, or null when it is
// not customer input at all.
//   press  pointerdown, and Enter/Space on an interactive element - the start
//          of a gesture (the only kind that can latch a phase-before-input)
//   drag   a pressed pointer or touch moving
//   wheel  a physical scroll wheel / trackpad
export function classifyInputKind(event: CustomerInputEventLike | null | undefined, options: CustomerInputOptions = {}): CustomerInputKind | null {
  if (!event || event.isTrusted !== true) return null;

  switch (event.type) {
    case "pointerdown":
      return "press";
    case "touchmove":
      return "drag";
    case "wheel":
      return "wheel";
    case "pointermove":
      // Pressed only: hover is not customer input.
      return typeof event.buttons === "number" && event.buttons > 0 ? "drag" : null;
    case "keydown": {
      if (event.repeat === true) return null;
      if (typeof event.key !== "string" || !ACTIVATION_KEYS.includes(event.key)) return null;
      return (options.isInteractiveTarget ?? isInteractiveElement)(event.target) ? "press" : null;
    }
    default:
      return null;
  }
}

// Pure classification: does this event count as customer input?
export function classifyInputEvent(event: CustomerInputEventLike | null | undefined, options: CustomerInputOptions = {}): boolean {
  return classifyInputKind(event, options) !== null;
}

export function attachCustomerInput(target: EventTarget, sink: InputSink, options: CustomerInputOptions = {}): CustomerInputBinding {
  const controller = new AbortController();
  const signal = controller.signal;

  const handler = (event: Event): void => {
    // Guards a listener that a non-conforming target failed to remove.
    if (signal.aborted) return;
    const kind = classifyInputKind(event, options);
    if (kind !== null) sink.noteCustomerInput(kind);
  };

  try {
    for (const type of CUSTOMER_INPUT_EVENT_TYPES) {
      target.addEventListener(type, handler, { capture: true, passive: true, signal });
    }
  } catch (error) {
    // Never leave a half-bound adapter behind.
    controller.abort();
    throw error;
  }

  return Object.freeze({
    dispose(): void {
      if (signal.aborted) return;
      controller.abort();
    },
  });
}
