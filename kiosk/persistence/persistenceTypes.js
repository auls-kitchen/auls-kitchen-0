"use strict";

/**
 * Kiosk persistence contract - shapes, constants, and pure validation
 * helpers only. No storage I/O lives here (see persistenceAdapter.js /
 * indexedDbAdapter.js). No Firebase, no OrderIntent, no AWR, no payment.
 *
 * Storage layout (documented per STEP 55/56):
 *
 *   ONE logical record per Kiosk device instance, stored under a single
 *   fixed key in whatever key-value store is injected into the adapter.
 *   The record shape is exactly:
 *
 *   {
 *     schemaVersion,
 *     ownerUidAtWrite,   // record-level identity tag - the primary
 *                        // isolation gate (STEP 55 Case 6: applied
 *                        // uniformly across all three data domains,
 *                        // since in correct operation they always
 *                        // belong to the one currently active
 *                        // Customer Session)
 *     writtenAt,         // record-level, updated on every write
 *     cartDraft: { ...CartDraft, writtenAt } | null,
 *     submissionAttempt: { ...SubmissionAttempt, writtenAt } | null,
 *     authoritativeResult: { ...AuthoritativeResult, idempotencyKey, writtenAt } | null,
 *   }
 *
 * Only ONE ownerUidAtWrite exists (at the record level), not one per
 * domain - a deliberate simplification over a literal per-domain
 * reading, since a domain-level ownerUidAtWrite could only ever equal
 * the record-level one in correct operation, and duplicating it would
 * be redundant. Each domain still carries its OWN writtenAt so expiry
 * can be evaluated independently per domain (STEP 55 S13/S14).
 */

const CURRENT_SCHEMA_VERSION = 1;

// idempotencyKey format, copied (not imported) from the PROVEN backend
// contract in functions/src/services/orderIntentInputValidation.js -
// duplicating this literal format constraint is not an OrderIntent
// dependency; it is a plain string-shape rule discovered read-only in
// prior discovery steps.
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9-_]{8,128}$/;

// The ONLY statuses the persistence layer will ever accept for save -
// per the locked contract, a SubmissionAttempt is persisted only while
// unresolved. SUCCEEDED/REJECTED are handled by explicit removal, never
// by saving a terminal status (STEP 55 S9, STEP 56 S11).
const PERSISTABLE_SUBMISSION_STATUSES = Object.freeze(["IN_FLIGHT", "UNKNOWN"]);

// Full status vocabulary, for reference/validation of values that must
// NEVER be accepted by save (kept here so the "invalid status rejected"
// test has something authoritative to check against).
const ALL_SUBMISSION_STATUSES = Object.freeze([
  "IDLE",
  "IN_FLIGHT",
  "SUCCEEDED",
  "REJECTED",
  "UNKNOWN",
]);

// Result codes returned by the adapter - deliberately distinct from one
// another so failure can never be mistaken for success or absence
// (STEP 56 S14).
const ResultCodes = Object.freeze({
  EMPTY: "EMPTY",
  VALID: "VALID",
  CORRUPT_RECORD: "CORRUPT_RECORD",
  UNSUPPORTED_SCHEMA: "UNSUPPORTED_SCHEMA",
  UID_MISMATCH: "UID_MISMATCH",
  READ_FAILURE: "READ_FAILURE",
});

const WriteErrorCodes = Object.freeze({
  VALIDATION_FAILURE: "VALIDATION_FAILURE",
  WRITE_FAILURE: "WRITE_FAILURE",
  DELETE_FAILURE: "DELETE_FAILURE",
});

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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a selectedModifiers array using the SAME identity rule Cart
 * Core already enforces (groupId+optionId, well-formed entries). Does
 * not re-derive a new rule - just checks the shape is well-formed;
 * order-independence is a Cart Core concern, not a persistence concern.
 */
function isValidSelectedModifiers(value) {
  if (!Array.isArray(value)) return false;
  return value.every(
    (m) => isPlainObject(m) && isNonEmptyString(m.groupId) && isNonEmptyString(m.optionId)
  );
}

/**
 * Validates one CartLine. displaySnapshot is treated as OPAQUE data -
 * only its "is it a plain object" shape is checked, never its internal
 * fields, since it is explicitly non-authoritative presentation cache
 * (STEP 54/55).
 */
function isValidCartLine(line) {
  return (
    isPlainObject(line) &&
    isNonEmptyString(line.localLineId) &&
    isNonEmptyString(line.productId) &&
    isPositiveInteger(line.quantity) &&
    isValidSelectedModifiers(line.selectedModifiers) &&
    isPlainObject(line.displaySnapshot)
  );
}

/**
 * Validates a CartDraft matching STEP 54's actual shape exactly:
 * { lines, customerName, notes }.
 */
function isValidCartDraft(cartDraft) {
  if (!isPlainObject(cartDraft)) return false;
  if (!Array.isArray(cartDraft.lines)) return false;
  if (!cartDraft.lines.every(isValidCartLine)) return false;
  if (!isStringOrNull(cartDraft.customerName)) return false;
  if (!isStringOrNull(cartDraft.notes)) return false;
  return true;
}

/**
 * Validates one SubmissionAttempt item (productId/quantity/selectedModifiers
 * only - matches OrderIntent's actual allowed item shape, never a price
 * or recipe field).
 */
function isValidSubmissionItem(item) {
  return (
    isPlainObject(item) &&
    isNonEmptyString(item.productId) &&
    isPositiveInteger(item.quantity) &&
    isValidSelectedModifiers(item.selectedModifiers)
  );
}

/**
 * Validates a SubmissionAttempt for SAVE purposes: status must be one of
 * the two persistable, unresolved statuses. A caller passing SUCCEEDED/
 * REJECTED/IDLE is rejected outright - terminal states are handled by
 * explicit removal, never by "saving" a terminal status.
 */
function isValidSubmissionAttemptForSave(attempt) {
  if (!isPlainObject(attempt)) return false;
  if (!isNonEmptyString(attempt.idempotencyKey)) return false;
  if (!IDEMPOTENCY_KEY_PATTERN.test(attempt.idempotencyKey)) return false;
  if (!Array.isArray(attempt.items) || attempt.items.length === 0) return false;
  if (!attempt.items.every(isValidSubmissionItem)) return false;
  if (!isStringOrNull(attempt.customerName)) return false;
  if (!isStringOrNull(attempt.notes)) return false;
  if (!PERSISTABLE_SUBMISSION_STATUSES.includes(attempt.status)) return false;
  if (attempt.committedAt !== undefined && !isFiniteNumber(attempt.committedAt)) return false;
  return true;
}

/**
 * Validates a persisted SubmissionAttempt record read back from storage
 * (its status must still be a persistable one - a terminal status found
 * in storage is itself a corruption signal, since the contract requires
 * terminal attempts to have been removed, never left with a terminal
 * status).
 */
function isValidStoredSubmissionAttempt(attempt) {
  return isValidSubmissionAttemptForSave(attempt) && isFiniteNumber(attempt.writtenAt);
}

/**
 * Validates the customer-safe AuthoritativeResult shape - the EXACT
 * fields buildOrderIntentSafeResponse returns (STEP 46, PROVEN), no
 * more, no fewer expected. Extra unrecognized fields are tolerated on
 * read (forward-compatible) but the required fields must be present
 * and well-formed.
 */
function isValidAuthoritativeResultItem(item) {
  if (!isPlainObject(item)) return false;
  if (!isNonEmptyString(item.productId)) return false;
  if (!isNonEmptyString(item.productName)) return false;
  if (!isPositiveInteger(item.quantity)) return false;
  if (!isFiniteNumber(item.unitPrice)) return false;
  if (!isFiniteNumber(item.lineTotal)) return false;
  if (!Array.isArray(item.selectedModifiers)) return false;
  return item.selectedModifiers.every(
    (m) =>
      isPlainObject(m) &&
      isNonEmptyString(m.groupName) &&
      isNonEmptyString(m.optionName) &&
      isFiniteNumber(m.price)
  );
}

function isValidAuthoritativeResult(result) {
  if (!isPlainObject(result)) return false;
  if (!isNonEmptyString(result.orderState)) return false;
  if (!isFiniteNumber(result.authoritativeTotal)) return false;
  if (!Array.isArray(result.items) || result.items.length === 0) return false;
  if (!result.items.every(isValidAuthoritativeResultItem)) return false;
  if (!isStringOrNull(result.customerName)) return false;
  if (!isStringOrNull(result.notes)) return false;
  return true;
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  IDEMPOTENCY_KEY_PATTERN,
  PERSISTABLE_SUBMISSION_STATUSES,
  ALL_SUBMISSION_STATUSES,
  ResultCodes,
  WriteErrorCodes,
  isPlainObject,
  isNonEmptyString,
  isPositiveInteger,
  isStringOrNull,
  isFiniteNumber,
  isValidSelectedModifiers,
  isValidCartLine,
  isValidCartDraft,
  isValidSubmissionItem,
  isValidSubmissionAttemptForSave,
  isValidStoredSubmissionAttempt,
  isValidAuthoritativeResult,
};
