// Pending-ticket detection and return routing (U1; routing reshaped by U4 S4a) -
// pure, read-only.
//
// Decides, from a Domain snapshot the caller already read, what customer context
// is still there (classifyPending), what a context expiry may ask the Domain to do
// about it (releasePlanFor), and where a returning customer is led
// (routeCustomerReturn). It takes plain data only: it holds no Domain handle, calls
// no Domain method, and never mutates the snapshot.
//
// classifyPending rules (approved, unchanged):
//   - NEVER decided from `session === "active"` alone. clearCart() leaves a
//     session "active" with no lines, and that is not a pending ticket.
//   - ACTIVE + cart lines  -> pending (ACTIVE_CART)
//   - CONFIRMATION         -> pending (CONFIRMATION)
//   - AWAITING_OUTCOME / UNKNOWN -> pending, unresolved (UNRESOLVED)
//   - ACTIVE + empty cart, or IDLE -> not pending (NONE)
//
// UNRESOLVED keys on the session phase (and PENDING/UNCERTAIN order status),
// not on the order alone: while a submit() call is still in flight the
// Runtime is already AWAITING_OUTCOME but holds no submission object yet, so
// the order status still reads NONE.
//
// Fail closed: a snapshot that is missing, not yet hydrated, or malformed is
// NOT_READY - never NONE. Reporting NONE would route into Discover, where an
// added item could later be overwritten by hydration.

import type { ExperienceSnapshotView } from "../contracts.ts";

export type PendingKind = "NOT_READY" | "NONE" | "ACTIVE_CART" | "CONFIRMATION" | "UNRESOLVED";

// Where a returning customer is led. Presentation routes only - none is a Domain
// state. There is deliberately NO ownership route: a new customer is never asked to
// confirm ownership of a previous customer's context.
//   WAIT_NOT_READY       the Domain cannot be read yet
//   DISCOVER_MENU        a fresh start
//   PROTECTED_NEUTRAL    an unresolved submission exists: a neutral view, no question
//   UNAVAILABLE_NEUTRAL  a releasable context could not be shown as fresh: a neutral
//                        view, distinct from waiting
export type WakeRoute = "WAIT_NOT_READY" | "DISCOVER_MENU" | "PROTECTED_NEUTRAL" | "UNAVAILABLE_NEUTRAL";

// The outcome of the CALLER'S OWN release of the context in the very snapshot it
// passes to routeCustomerReturn. It is never another customer's outcome: whoever
// routes must have started (and observed) its own release.
export type WakeReleaseVerdict = "FRESH" | "UNAVAILABLE";

export interface WakeDecision {
  readonly route: WakeRoute;
  // What the snapshot read as. Diagnostic data for the host hook only; it is never
  // rendered, so no previous customer's ticket kind reaches the shell.
  readonly pending: PendingKind;
}

const KNOWN_SESSIONS: readonly string[] = ["idle", "active", "awaiting_outcome", "confirmation"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyPending(snapshot: ExperienceSnapshotView | null | undefined): PendingKind {
  const candidate: unknown = snapshot;
  if (!isRecord(candidate) || candidate.ready !== true) return "NOT_READY";

  const { session, cart, order } = candidate;
  if (typeof session !== "string" || !KNOWN_SESSIONS.includes(session)) return "NOT_READY";
  if (!isRecord(cart) || !Array.isArray(cart.lines)) return "NOT_READY";
  if (!isRecord(order)) return "NOT_READY";

  if (session === "awaiting_outcome" || order.status === "PENDING" || order.status === "UNCERTAIN") {
    return "UNRESOLVED";
  }
  if (session === "confirmation") return "CONFIRMATION";
  if (session === "active" && cart.lines.length > 0) return "ACTIVE_CART";
  return "NONE";
}

// Where a returning customer's first input should lead, given the snapshot read at
// that moment and, only when the snapshot holds a releasable context, the caller's own
// release verdict. Routing only - it performs no Domain action.
//
//   plan NOT_READY        -> WAIT_NOT_READY
//   plan PROTECTED        -> PROTECTED_NEUTRAL   (a verdict can never change this)
//   plan NONE_TO_RELEASE  -> DISCOVER_MENU       (a verdict is irrelevant)
//   plan RELEASE          -> DISCOVER_MENU only for the exact verdict "FRESH"
//                            (pending reads NONE: that context is gone);
//                            with no verdict, "UNAVAILABLE", or anything else
//                            -> UNAVAILABLE_NEUTRAL (fail closed: a releasable
//                            context is never presented as a fresh kiosk on a guess)
export function routeCustomerReturn(snapshot: ExperienceSnapshotView | null | undefined, verdict?: WakeReleaseVerdict): WakeDecision {
  const pending = classifyPending(snapshot);
  switch (releasePlanFor(snapshot)) {
    case "NOT_READY":
      return Object.freeze({ route: "WAIT_NOT_READY", pending });
    case "PROTECTED":
      return Object.freeze({ route: "PROTECTED_NEUTRAL", pending });
    case "NONE_TO_RELEASE":
      return Object.freeze({ route: "DISCOVER_MENU", pending });
    case "RELEASE":
      return verdict === "FRESH"
        ? Object.freeze({ route: "DISCOVER_MENU", pending: "NONE" })
        : Object.freeze({ route: "UNAVAILABLE_NEUTRAL", pending });
  }
}

// What a context expiry may ask the Domain to do about the customer context it finds.
//   RELEASE          a customer context is there and releasable: an ACTIVE session
//                    (with Cart lines OR an empty Cart - the name/notes/session are
//                    still customer context) or a CONFIRMATION
//   NONE_TO_RELEASE  an idle session: nothing to release
//   PROTECTED        an unresolved submission (AWAITING_OUTCOME / UNKNOWN / a pending or
//                    uncertain order): business evidence, never released by the caller
//   NOT_READY        the snapshot cannot be read as a ready Domain: never guessed
export type ReleasePlan = "RELEASE" | "NONE_TO_RELEASE" | "PROTECTED" | "NOT_READY";

// Pure and read-only: it looks at a snapshot the caller already read and returns a
// constant. It performs no Domain action, holds no handle, and is total - anything it
// cannot read (including a snapshot whose getters throw) is NOT_READY, so a failure
// here can only ever mean "do not release". Unlike classifyPending it separates an
// ACTIVE session with an empty Cart (releasable) from an idle one (nothing to release).
export function releasePlanFor(snapshot: ExperienceSnapshotView | null | undefined): ReleasePlan {
  try {
    const pending = classifyPending(snapshot);
    if (pending === "NOT_READY") return "NOT_READY";
    if (pending === "UNRESOLVED") return "PROTECTED";
    // Past this point classifyPending has validated the snapshot and its session.
    const session = (snapshot as { readonly session?: unknown }).session;
    return session === "active" || session === "confirmation" ? "RELEASE" : "NONE_TO_RELEASE";
  } catch {
    return "NOT_READY";
  }
}
