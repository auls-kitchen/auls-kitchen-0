// Takeover policy (U4 Slice 2A) - pure, read-only.
//
// Decides, from the phase the Experience was in BEFORE a customer pressed
// Home/X and a Domain snapshot the caller already read, whether that press may
// take the kiosk over from whoever left a context behind. It returns a decision
// and nothing else: it holds no Domain handle, calls no Domain method, touches
// no DOM, emits no event, and never mutates its input. Acting on a takeover
// decision (releasing the context) is a separate, later step; this module only
// defines where the boundary is.
//
//   NOT_READY              the Domain cannot be read as ready (missing, not
//                          hydrated, malformed) - never guessed as "no ticket"
//   BLOCKED_UNKNOWN        an unresolved submission (AWAITING_OUTCOME / UNKNOWN
//                          / a pending or uncertain order). Never a takeover, in
//                          ANY phase: it is business evidence, not customer context
//   NO_TAKEOVER            nothing may be taken over (before the release boundary,
//                          or nothing left behind, or a phase that is not RELEASED)
//   TAKEOVER_ACTIVE_CART   RELEASED, and an ACTIVE session with Cart lines
//   TAKEOVER_CONFIRMATION  RELEASED, and a CONFIRMATION (itself a ticket context)
//
// Decision order (first match wins):
//   1. snapshot missing / not ready              -> NOT_READY
//   2. unresolved submission                     -> BLOCKED_UNKNOWN
//   3. phaseBefore is not RELEASED               -> NO_TAKEOVER
//   4. RELEASED + ACTIVE + Cart >= 1             -> TAKEOVER_ACTIVE_CART
//   5. RELEASED + CONFIRMATION                   -> TAKEOVER_CONFIRMATION
//   6. anything else (ACTIVE with an empty Cart, IDLE) -> NO_TAKEOVER
//
// The ordering is deliberate: NOT_READY and BLOCKED_UNKNOWN are decided before
// the phase is even looked at, so no phase - however late - can turn an
// unreadable or unresolved Domain into a takeover, and the only two takeover
// results are reachable solely from `RELEASED` plus a releasable snapshot.
// Fail closed: a phase that is not exactly the string "RELEASED" (including
// anything unexpected at runtime) is NO_TAKEOVER.

import type { ExperienceSnapshotView } from "../contracts.ts";
import type { RestingPhase } from "./interactionContext.ts";
import { classifyPending } from "./pendingTicket.ts";
import type { PendingKind } from "./pendingTicket.ts";

export type TakeoverDecision =
  | "NO_TAKEOVER"
  | "TAKEOVER_ACTIVE_CART"
  | "TAKEOVER_CONFIRMATION"
  | "BLOCKED_UNKNOWN"
  | "NOT_READY";

export interface TakeoverInput {
  // The phase before the press that started the gesture (never the phase after it).
  readonly phaseBefore: RestingPhase;
  readonly snapshot: ExperienceSnapshotView | null | undefined;
}

export function decideTakeover(input: TakeoverInput): TakeoverDecision {
  // Total: a snapshot that cannot even be inspected is NOT_READY, so nothing
  // thrown here can escape into a DOM event handler or become a takeover.
  let pending: PendingKind;
  try {
    pending = classifyPending(input.snapshot);
  } catch {
    return "NOT_READY";
  }

  // 1 + 2: the Domain must be readable, and an unresolved submission is never released.
  if (pending === "NOT_READY") return "NOT_READY";
  if (pending === "UNRESOLVED") return "BLOCKED_UNKNOWN";

  // 3: only the RELEASED boundary permits a takeover.
  if (input.phaseBefore !== "RELEASED") return "NO_TAKEOVER";

  // 4 + 5 + 6.
  if (pending === "ACTIVE_CART") return "TAKEOVER_ACTIVE_CART";
  if (pending === "CONFIRMATION") return "TAKEOVER_CONFIRMATION";
  return "NO_TAKEOVER";
}
