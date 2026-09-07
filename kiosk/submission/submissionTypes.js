"use strict";

/**
 * Kiosk Submission Attempt - shapes, constants, and pure validation/
 * cloning helpers only. No I/O, no Firebase, no OrderIntent, no
 * persistence, no Cart Core dependency - deliberately self-contained
 * (same isolation pattern already used by kiosk/persistence/), so this
 * module has zero cross-dependency on kiosk/cart/* or kiosk/persistence/*.
 *
 * SubmissionAttempt shape (STEP 53, unchanged):
 *
 *   {
 *     idempotencyKey,
 *     items: [{ productId, quantity, selectedModifiers: [{groupId,optionId}] }],
 *     customerName,
 *     notes,
 *     status,       // "IN_FLIGHT" | "SUCCEEDED" | "REJECTED" | "UNKNOWN"
 *     committedAt,  // set once, at creation - never changes on retry
 *     ownerUid,     // optional, carried per STEP 56's association - an
 *                   // authentication identity, NEVER a customerId
 *     rejectionReason,     // local-only diagnostic, present only when REJECTED
 *     unknownReason,       // local-only diagnostic, present only when UNKNOWN
 *     authoritativeResult, // present only when SUCCEEDED - supplied by the
 *                          // caller, never computed here
 *   }
 *
 * "No active SubmissionAttempt" is represented as the state machine's
 * state being `null` - not as some IDLE-status object. This makes the
 * three states STEP 57 requires distinguishable in code:
 *   A. no active attempt   -> state === null
 *   B. unresolved attempt  -> state.status is IN_FLIGHT or UNKNOWN
 *   C. terminal attempt    -> state.status is SUCCEEDED or REJECTED
 */

// Copied (not imported) from the PROVEN backend contract in
// functions/src/services/orderIntentInputValidation.js - this is a
// plain string-format constraint, not an OrderIntent dependency.
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9-_]{8,128}$/;

const Status = Object.freeze({
  IN_FLIGHT: "IN_FLIGHT",
  SUCCEEDED: "SUCCEEDED",
  REJECTED: "REJECTED",
  UNKNOWN: "UNKNOWN",
});

const UNRESOLVED_STATUSES = Object.freeze([Status.IN_FLIGHT, Status.UNKNOWN]);
const TERMINAL_STATUSES = Object.freeze([Status.SUCCEEDED, Status.REJECTED]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isStringOrNull(value) {
  return value === null || typeof value === "string";
}

function isValidIdempotencyKey(value) {
  return isNonEmptyString(value) && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function isValidSelectedModifiers(value) {
  if (!Array.isArray(value)) return false;
  return value.every(
    (m) => isPlainObject(m) && isNonEmptyString(m.groupId) && isNonEmptyString(m.optionId)
  );
}

function isValidSubmissionItem(item) {
  return (
    isPlainObject(item) &&
    isNonEmptyString(item.productId) &&
    isPositiveInteger(item.quantity) &&
    isValidSelectedModifiers(item.selectedModifiers)
  );
}

function isValidItemsArray(items) {
  return Array.isArray(items) && items.length > 0 && items.every(isValidSubmissionItem);
}

/**
 * Deterministic default idempotencyKey generator - deliberately no
 * stronger than the backend's own accepted format requires. Callers
 * MAY inject their own generator (e.g. a fixed-string one in tests) so
 * key identity can be verified without relying on real randomness.
 */
let _keyCounter = 0;
function defaultGenerateIdempotencyKey() {
  _keyCounter += 1;
  return (
    "sub_" +
    Date.now().toString(36) +
    "_" +
    _keyCounter.toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Recursively clones and freezes a plain-data value (objects/arrays of
 * strings/numbers/booleans/null only - the exact shape SubmissionAttempt
 * content ever contains). This is what guarantees a captured snapshot
 * can never be mutated by a later change to the caller's own original
 * objects (STEP 57 S13's Cart boundary requirement).
 */
function deepFreezeClone(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezeClone));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = deepFreezeClone(value[key]);
    }
    return Object.freeze(out);
  }
  return value; // primitives are already immutable
}

module.exports = {
  IDEMPOTENCY_KEY_PATTERN,
  Status,
  UNRESOLVED_STATUSES,
  TERMINAL_STATUSES,
  isPlainObject,
  isNonEmptyString,
  isPositiveInteger,
  isStringOrNull,
  isValidIdempotencyKey,
  isValidSelectedModifiers,
  isValidSubmissionItem,
  isValidItemsArray,
  defaultGenerateIdempotencyKey,
  deepFreezeClone,
};
