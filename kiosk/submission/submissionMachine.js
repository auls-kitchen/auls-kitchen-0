"use strict";

/**
 * Kiosk Submission Attempt state machine - pure application logic only.
 *
 * No Firebase, no Firestore, no OrderIntent network call, no
 * persistence/storage, no Cart Core import, no UI, no AWR, no payment.
 * Every function here is (state, ...args) -> result; nothing performs
 * I/O, nothing schedules a timer, nothing touches the network.
 *
 * State representation:
 *   null                       -> no active SubmissionAttempt (IDLE)
 *   { status: "IN_FLIGHT", .. }  -> unresolved
 *   { status: "UNKNOWN", .. }    -> unresolved, safety-sensitive
 *   { status: "SUCCEEDED", .. }  -> terminal
 *   { status: "REJECTED", .. }   -> terminal
 *
 * Every transition function returns either:
 *   { ok: true, attempt: <next state> }
 * or, for an illegal transition or invalid input:
 *   { ok: false, code: "ILLEGAL_TRANSITION" | "VALIDATION_FAILURE", state: <unchanged prior state> }
 *
 * On failure, `state` is the EXACT SAME reference as the input state
 * (never a copy) - callers can assert reference equality to prove
 * nothing was silently mutated, mirroring Cart Core's own no-op
 * convention (STEP 54).
 */

const {
  Status,
  isNonEmptyString,
  isStringOrNull,
  isValidIdempotencyKey,
  isValidItemsArray,
  defaultGenerateIdempotencyKey,
  deepFreezeClone,
} = require("./submissionTypes");

function illegal(state) {
  return { ok: false, code: "ILLEGAL_TRANSITION", state };
}

function invalid(state) {
  return { ok: false, code: "VALIDATION_FAILURE", state };
}

/**
 * Begins a NEW logical submission. Legal ONLY when there is no active
 * attempt at all (state === null) - a terminal attempt must first be
 * explicitly cleared via clearTerminalAttempt(). This is a deliberate,
 * conservative design choice: the state machine itself refuses to
 * silently skip the "previous attempt is definitively terminal and has
 * been cleared" precondition (STEP 57 S5/S12), rather than relying on
 * every future caller to remember to clear before beginning again.
 *
 * Captures an immutable snapshot: later mutation of the caller's own
 * `items`/`customerName`/`notes` objects can never affect the stored
 * attempt, because everything is deep-cloned and frozen here.
 *
 * @param {null} state - must be null (no active attempt)
 * @param {{items, customerName, notes, ownerUid}} input
 * @param {{generateKey?: () => string}} [deps] - injectable key generator,
 *   for deterministic tests; defaults to defaultGenerateIdempotencyKey.
 */
function beginSubmission(state, input, deps) {
  if (state !== null) return illegal(state);

  const safeInput = input || {};
  if (!isValidItemsArray(safeInput.items)) return invalid(state);
  if (!isStringOrNull(safeInput.customerName === undefined ? null : safeInput.customerName)) {
    return invalid(state);
  }
  if (!isStringOrNull(safeInput.notes === undefined ? null : safeInput.notes)) {
    return invalid(state);
  }

  const generateKey = (deps && deps.generateKey) || defaultGenerateIdempotencyKey;
  const idempotencyKey = generateKey();
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return { ok: false, code: "KEY_GENERATION_FAILURE", state };
  }

  const attempt = Object.freeze({
    idempotencyKey,
    items: deepFreezeClone(safeInput.items),
    customerName: safeInput.customerName === undefined ? null : safeInput.customerName,
    notes: safeInput.notes === undefined ? null : safeInput.notes,
    status: Status.IN_FLIGHT,
    committedAt: Date.now(),
    ownerUid: safeInput.ownerUid === undefined ? null : safeInput.ownerUid,
  });

  return { ok: true, attempt };
}

/**
 * IN_FLIGHT -> SUCCEEDED. Accepts an authoritative result SUPPLIED by
 * the (not-yet-implemented) OrderIntent adapter - never computes,
 * calculates, or fabricates one itself. Does not alter submitted
 * content and does not touch the idempotencyKey.
 */
function markSuccess(state, authoritativeResult) {
  if (state === null || state.status !== Status.IN_FLIGHT) return illegal(state);
  if (authoritativeResult === undefined || authoritativeResult === null || typeof authoritativeResult !== "object") {
    return invalid(state);
  }

  const attempt = Object.freeze({
    ...state,
    status: Status.SUCCEEDED,
    authoritativeResult: deepFreezeClone(authoritativeResult),
  });
  return { ok: true, attempt };
}

/**
 * IN_FLIGHT -> REJECTED. `reason` is a local-only diagnostic string,
 * never fabricated backend data. Does not generate another key.
 */
function markRejected(state, reason) {
  if (state === null || state.status !== Status.IN_FLIGHT) return illegal(state);
  if (!isStringOrNull(reason === undefined ? null : reason)) return invalid(state);

  const attempt = Object.freeze({
    ...state,
    status: Status.REJECTED,
    rejectionReason: reason === undefined ? null : reason,
  });
  return { ok: true, attempt };
}

/**
 * IN_FLIGHT -> UNKNOWN. The safety-sensitive state: "the system cannot
 * currently establish whether the previous OrderIntent attempt reached
 * a definitive backend outcome." Preserves the exact key and content;
 * adds only a local diagnostic reason.
 */
function markUnknown(state, reason) {
  if (state === null || state.status !== Status.IN_FLIGHT) return illegal(state);
  if (!isStringOrNull(reason === undefined ? null : reason)) return invalid(state);

  const attempt = Object.freeze({
    ...state,
    status: Status.UNKNOWN,
    unknownReason: reason === undefined ? null : reason,
  });
  return { ok: true, attempt };
}

/**
 * UNKNOWN -> IN_FLIGHT, reusing the SAME idempotencyKey and the SAME
 * submitted content. This is the ONLY way an UNKNOWN attempt ever moves
 * forward again - there is no operation anywhere in this module that
 * produces a new key from an UNKNOWN state. Retrying an IN_FLIGHT or a
 * terminal attempt is illegal (a terminal attempt cannot be retried at
 * all - see module docs).
 */
function retry(state) {
  if (state === null || state.status !== Status.UNKNOWN) return illegal(state);

  const { unknownReason, ...rest } = state;
  const attempt = Object.freeze({
    ...rest,
    status: Status.IN_FLIGHT,
  });
  return { ok: true, attempt };
}

/**
 * The ONLY legal way to return to "no active attempt." Legal only when
 * there is nothing to clear (state === null, idempotent) or the
 * attempt is already terminal (SUCCEEDED/REJECTED). Calling this on an
 * unresolved attempt (IN_FLIGHT/UNKNOWN) is illegal and refused - this
 * is the structural enforcement of "never silently discard an
 * unresolved attempt."
 */
function clearTerminalAttempt(state) {
  if (state === null) return { ok: true, attempt: null };
  if (state.status === Status.SUCCEEDED || state.status === Status.REJECTED) {
    return { ok: true, attempt: null };
  }
  return illegal(state);
}

module.exports = {
  beginSubmission,
  markSuccess,
  markRejected,
  markUnknown,
  retry,
  clearTerminalAttempt,
};
