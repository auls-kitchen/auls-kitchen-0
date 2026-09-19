// Pending-ticket detection and return routing (U1) - pure, read-only.
//
// Decides, from a Domain snapshot the caller already read, whether a
// customer context is still pending. It takes plain data only: it holds no
// Domain handle, calls no Domain method, and never mutates the snapshot.
//
// Rules (approved):
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

export type WakeRoute = "WAIT_NOT_READY" | "DISCOVER_MENU" | "OWNERSHIP_CONFIRMATION";

export interface WakeDecision {
  readonly route: WakeRoute;
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

export function hasPendingTicket(kind: PendingKind): boolean {
  return kind === "ACTIVE_CART" || kind === "CONFIRMATION" || kind === "UNRESOLVED";
}

// Where a returning customer's first input should lead, given the snapshot
// read at that moment. Routing only - it performs no Domain action.
export function routeCustomerReturn(snapshot: ExperienceSnapshotView | null | undefined): WakeDecision {
  const pending = classifyPending(snapshot);
  if (pending === "NOT_READY") return Object.freeze({ route: "WAIT_NOT_READY", pending });
  if (hasPendingTicket(pending)) return Object.freeze({ route: "OWNERSHIP_CONFIRMATION", pending });
  return Object.freeze({ route: "DISCOVER_MENU", pending });
}
