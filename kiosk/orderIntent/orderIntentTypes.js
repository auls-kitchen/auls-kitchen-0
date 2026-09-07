"use strict";

/**
 * Kiosk OrderIntent adapter - shapes, constants, and pure validation
 * helpers only. No I/O, no Firebase, no Cart Core, no AWR, no payment.
 * Deliberately self-contained (same isolation pattern already used by
 * kiosk/persistence/ and kiosk/submission/).
 *
 * ACTUAL backend contract, verified by direct read of the real source
 * this step (not assumed from prior steps' descriptions):
 *
 *   Callable name: "orderIntent"
 *   (functions/index.js exports it; invoked in the existing
 *   verification harness via httpsCallable(functions, "orderIntent"))
 *
 *   Request (functions/src/services/orderIntentInputValidation.js):
 *     { idempotencyKey, items: [{productId, quantity, selectedModifiers:
 *       [{groupId, optionId}]}], customerName, notes }
 *   Any other field the client sends is silently ignored server-side -
 *   this adapter does not rely on that; it never constructs one.
 *
 *   Response (functions/src/services/orderIntentProjection.js):
 *     { orderState, authoritativeTotal, items: [{productId, productName,
 *       quantity, unitPrice, lineTotal, selectedModifiers:
 *       [{groupName, optionName, price}]}], customerName, notes }
 *
 *   Error codes actually thrown by functions/src/functions/orderIntent.js:
 *     "invalid-argument"     - shape validation (orderIntentInputValidation.js),
 *                              thrown BEFORE any Firestore read/write. PROVEN no-commit.
 *     "unauthenticated"      - authGuard.js, the very first line of the
 *                              function, before shape validation even runs.
 *                              PROVEN no-commit.
 *     "failed-precondition"  - OrderValidationError business rejections
 *                              (err.details.code carries the specific reason:
 *                              PRODUCT_UNAVAILABLE, MODIFIER_GROUP_UNAVAILABLE,
 *                              MODIFIER_OPTION_UNAVAILABLE, REQUIRED_MODIFIER_MISSING,
 *                              INSUFFICIENT_STOCK, IDEMPOTENCY_KEY_CONFLICT).
 *                              PRODUCT_UNAVAILABLE, MODIFIER_GROUP_UNAVAILABLE,
 *                              MODIFIER_OPTION_UNAVAILABLE, and REQUIRED_MODIFIER_MISSING
 *                              are thrown before the reservation transaction even
 *                              starts. INSUFFICIENT_STOCK is thrown INSIDE the
 *                              Firestore transaction but before any decrement -
 *                              an aborted Firestore transaction performs zero
 *                              writes. IDEMPOTENCY_KEY_CONFLICT proves THIS
 *                              request's own key was never committed for THIS
 *                              caller. All four are PROVEN no-commit for the
 *                              calling attempt.
 *     "internal"              - the function's own catch-all for anything that
 *                              is NOT an OrderValidationError. The backend's own
 *                              comment labels this "Unexpected/internal failure"
 *                              and does NOT guarantee it occurs before any write
 *                              (e.g. it could fire after a successful reservation
 *                              transaction, from a later step). This is NOT
 *                              provably no-commit and must be classified UNKNOWN,
 *                              never REJECTED.
 *
 *   Any other error code (a genuine Firebase Functions client transport
 *   error, a dropped connection, a timeout, or anything this adapter does
 *   not recognize) is likewise classified UNKNOWN by default - this
 *   adapter uses an ALLOWLIST of provably-safe-to-reject codes, not a
 *   denylist of "known bad" codes, specifically so an unrecognized
 *   condition defaults to the SAFE outcome (UNKNOWN), never the unsafe
 *   one (REJECTED).
 */

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
 * Error codes that the ACTUAL backend source proves are thrown before
 * any commit could have occurred for the calling attempt. Anything
 * NOT in this set is classified UNKNOWN, never REJECTED.
 */
const PROVEN_NO_COMMIT_ERROR_CODES = Object.freeze([
  "invalid-argument",
  "unauthenticated",
  "failed-precondition",
]);

/**
 * Validates the customer-safe AuthoritativeResult shape - the EXACT
 * fields buildOrderIntentSafeResponse returns, no more required. Used
 * to refuse manufacturing SUCCESS from a malformed/incomplete response.
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

function isValidAuthoritativeResultShape(result) {
  if (!isPlainObject(result)) return false;
  if (!isNonEmptyString(result.orderState)) return false;
  if (!isFiniteNumber(result.authoritativeTotal)) return false;
  if (!Array.isArray(result.items)) return false;
  if (!result.items.every(isValidAuthoritativeResultItem)) return false;
  if (!isStringOrNull(result.customerName)) return false;
  if (!isStringOrNull(result.notes)) return false;
  return true;
}

/**
 * Builds the EXACT request payload the backend accepts, from the
 * SubmissionAttempt's own captured content only - never from a live
 * Cart, never including any field beyond this allowlist.
 */
function buildOrderIntentRequestPayload(attempt) {
  return {
    idempotencyKey: attempt.idempotencyKey,
    items: attempt.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      selectedModifiers: item.selectedModifiers.map((m) => ({
        groupId: m.groupId,
        optionId: m.optionId,
      })),
    })),
    customerName: attempt.customerName,
    notes: attempt.notes,
  };
}

/**
 * Classifies a thrown/rejected error from the callable invocation.
 * Returns { disposition: "REJECTED" | "UNKNOWN", category, reason }.
 *
 * disposition drives which Submission Machine transition the adapter
 * calls; category/reason are local diagnostic detail only, never
 * fabricated backend data.
 */
function classifyCallableError(err) {
  const code = err && typeof err.code === "string" ? err.code : null;

  if (code && PROVEN_NO_COMMIT_ERROR_CODES.includes(code)) {
    if (code === "unauthenticated") {
      return { disposition: "REJECTED", category: "AUTH_REJECTION", reason: "AUTH_REQUIRED" };
    }
    if (code === "invalid-argument") {
      return { disposition: "REJECTED", category: "VALIDATION_REJECTION", reason: "INVALID_REQUEST_SHAPE" };
    }
    // failed-precondition: the specific business code lives in err.details.code
    // per the backend's own HttpsError(...,...,{code: err.code}) construction.
    const businessCode =
      err.details && isNonEmptyString(err.details.code) ? err.details.code : "UNSPECIFIED_BUSINESS_REJECTION";
    const category = businessCode === "IDEMPOTENCY_KEY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "VALIDATION_REJECTION";
    return { disposition: "REJECTED", category, reason: businessCode };
  }

  // "internal", any transport-level code (network failure, timeout,
  // dropped connection), or anything unrecognized: cannot be proven
  // no-commit. Safety rule: when uncertain, UNKNOWN, never REJECTED.
  const reason = code ? "BACKEND_" + code.toUpperCase() + "_AMBIGUOUS_COMMIT_STATUS" : "TRANSPORT_ERROR_NO_RESPONSE";
  const category = code === "internal" ? "INTERNAL_UNKNOWN" : "TRANSPORT_UNKNOWN";
  return { disposition: "UNKNOWN", category, reason };
}

module.exports = {
  PROVEN_NO_COMMIT_ERROR_CODES,
  isValidAuthoritativeResultShape,
  buildOrderIntentRequestPayload,
  classifyCallableError,
};
