"use strict";

/**
 * Kiosk Customer Session - shapes and constants only. No I/O, no
 * Firebase, no IndexedDB, no OrderIntent, no Cart reducer, no AWR, no
 * payment. Deliberately self-contained (same isolation pattern already
 * used by kiosk/persistence/, kiosk/submission/, kiosk/orderIntent/).
 *
 * HARD ARCHITECTURAL RULE (STEP 59 S3): Customer Session lifecycle is
 * NOT the same thing as order/business lifecycle. This module never
 * equates OrderIntent VALIDATED, Payment success, or Fulfillment
 * complete with Session End - those remain other domains' authority
 * entirely. This module is authority only for "is this Customer
 * Session allowed to end," never for "did the order succeed."
 *
 * Session states (deliberately minimal - STEP 59 S4):
 *   IDLE             - no active Customer Session
 *   ACTIVE           - customer is actively building a Cart
 *   AWAITING_OUTCOME - a SubmissionAttempt exists and is unresolved
 *                      (IN_FLIGHT or UNKNOWN) - this state's very
 *                      existence already encodes "ambiguous," which is
 *                      why reaching it is itself a reason Session End
 *                      requests from it are refused (see sessionMachine.js).
 *   CONFIRMATION     - an authoritative result is available; the
 *                      customer may still be physically present,
 *                      possibly through a future Payment-waiting phase.
 *
 * Event types this module recognizes. Deliberately meaningful lifecycle
 * facts, not raw UI clicks (STEP 59 S15).
 */

const SessionStates = Object.freeze({
  IDLE: "IDLE",
  ACTIVE: "ACTIVE",
  AWAITING_OUTCOME: "AWAITING_OUTCOME",
  CONFIRMATION: "CONFIRMATION",
});

const EventTypes = Object.freeze({
  FIRST_CART_ITEM_ADDED: "FIRST_CART_ITEM_ADDED",
  SUBMISSION_STARTED: "SUBMISSION_STARTED",
  AUTHORITATIVE_RESULT_AVAILABLE: "AUTHORITATIVE_RESULT_AVAILABLE",
  SUBMISSION_REJECTED: "SUBMISSION_REJECTED",
  CUSTOMER_RETURNED_TO_IDLE: "CUSTOMER_RETURNED_TO_IDLE",
  INACTIVITY_TIMEOUT: "INACTIVITY_TIMEOUT",
  CUSTOMER_COMPLETED: "CUSTOMER_COMPLETED",
  CUSTOMER_CANCELLED: "CUSTOMER_CANCELLED",
});

// Disengagement-family events require CONFIRMATION to already have been
// reached (confirmation shown). CUSTOMER_CANCELLED is the one
// pre-submit exception, requiring ACTIVE instead (STEP 59 S6/S7).
const DISENGAGEMENT_EVENT_TYPES = Object.freeze([
  EventTypes.CUSTOMER_RETURNED_TO_IDLE,
  EventTypes.INACTIVITY_TIMEOUT,
  EventTypes.CUSTOMER_COMPLETED,
]);

// SubmissionAttempt statuses considered "unresolved"/ambiguous for the
// purposes of the ambiguity guard - duplicated as plain strings (not
// imported from kiosk/submission/submissionTypes) to keep this module
// at zero cross-dependency, consistent with the rest of this codebase's
// per-module isolation pattern.
const AMBIGUOUS_SUBMISSION_STATUSES = Object.freeze(["IN_FLIGHT", "UNKNOWN"]);

// The exact, locked reset step order (STEP 55/56/59). Each entry names
// the injected dependency key and the failure code used if that step
// throws or returns { ok: false }.
const RESET_STEPS = Object.freeze([
  Object.freeze({ dep: "clearCart", failureCode: "CLEAR_CART_FAILED" }),
  Object.freeze({ dep: "clearTerminalSubmission", failureCode: "CLEAR_SUBMISSION_FAILED" }),
  Object.freeze({ dep: "clearAuthoritativeResult", failureCode: "CLEAR_RESULT_FAILED" }),
  Object.freeze({ dep: "purgePersistence", failureCode: "PURGE_FAILED" }),
]);

module.exports = {
  SessionStates,
  EventTypes,
  DISENGAGEMENT_EVENT_TYPES,
  AMBIGUOUS_SUBMISSION_STATUSES,
  RESET_STEPS,
};
