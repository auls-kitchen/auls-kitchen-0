"use strict";

/**
 * Kiosk OrderIntent adapter - the FIRST module allowed to cross the
 * Kiosk -> backend boundary. Orchestrates, in strict order:
 *
 *   Submission Attempt (from kiosk/submission/submissionMachine)
 *       -> PERSIST IN_FLIGHT (via an injected persistence dependency)
 *       -> ONLY THEN invoke the existing orderIntent callable
 *       -> classify the outcome (SUCCEEDED / REJECTED / UNKNOWN)
 *
 * This module does NOT:
 *   - import firebase-functions, firebase-admin, or any Firebase SDK
 *   - construct getFunctions()/httpsCallable() itself
 *   - import kiosk/persistence/* or kiosk/cart/*
 *   - generate an idempotencyKey (that remains Submission Machine's job)
 *   - compute price/HPP/recipe/stock
 *   - know about Customer Session, Auth rotation, Payment, AWR, or UI
 *
 * Every external capability is received as an explicit dependency:
 *   - `callOrderIntent(payload) -> Promise<{data}>` - a thin function the
 *     REAL caller builds from `httpsCallable(functions, "orderIntent")`.
 *     This module only ever calls it as an opaque async function.
 *   - `persistence` - an object matching kiosk/persistence's actual
 *     adapter shape ({saveSubmissionAttempt, saveAuthoritativeResult,
 *     removeSubmissionAttempt}), constructed and injected by the real
 *     caller. Duck-typed - no hard require of that module exists here.
 */

const {
  beginSubmission,
  markSuccess,
  markRejected,
  markUnknown,
  retry,
} = require("../submission/submissionMachine");
const { isValidAuthoritativeResultShape, buildOrderIntentRequestPayload, classifyCallableError } = require("./orderIntentTypes");

/**
 * Persists the given IN_FLIGHT/UNKNOWN attempt BEFORE any network call.
 * This is the write-ahead safety boundary: if this fails, the caller
 * must not proceed to the network call, must not generate a
 * replacement key, and must not silently reset to IDLE.
 */
async function persistPendingAttempt(persistence, ownerUid, attempt) {
  let saveResult;
  try {
    saveResult = await persistence.saveSubmissionAttempt(ownerUid, attempt);
  } catch (error) {
    return { ok: false, code: "PERSISTENCE_THREW", error };
  }
  if (!saveResult || saveResult.ok !== true) {
    return { ok: false, code: (saveResult && saveResult.code) || "PERSISTENCE_FAILED", error: saveResult && saveResult.error };
  }
  return { ok: true };
}

async function handleCallableSuccess(rawResult, currentAttempt, ownerUid, persistence) {
  const data = rawResult && rawResult.data;

  if (!isValidAuthoritativeResultShape(data)) {
    // A response was received, but its shape cannot be trusted enough
    // to declare definitive success. Do NOT manufacture SUCCESS from
    // an incomplete/malformed response - classify conservatively.
    const unknownTransition = markUnknown(currentAttempt, "MALFORMED_SUCCESS_RESPONSE");
    const nextAttempt = unknownTransition.ok ? unknownTransition.attempt : currentAttempt;
    if (unknownTransition.ok) {
      await persistence.saveSubmissionAttempt(ownerUid, nextAttempt);
    }
    return { outcome: "UNKNOWN", category: "MALFORMED_RESPONSE", attempt: nextAttempt };
  }

  const successTransition = markSuccess(currentAttempt, data);
  if (!successTransition.ok) {
    // Defensive only - should not occur given currentAttempt is
    // IN_FLIGHT at this point in the flow.
    return { outcome: "UNKNOWN", category: "STATE_MACHINE_REJECTED_SUCCESS", attempt: currentAttempt };
  }

  await persistence.saveAuthoritativeResult(ownerUid, currentAttempt.idempotencyKey, data);
  await persistence.removeSubmissionAttempt(ownerUid);

  return { outcome: "SUCCEEDED", attempt: successTransition.attempt };
}

async function handleCallableError(err, currentAttempt, ownerUid, persistence) {
  const classification = classifyCallableError(err);

  if (classification.disposition === "REJECTED") {
    const rejectedTransition = markRejected(currentAttempt, classification.reason);
    const nextAttempt = rejectedTransition.ok ? rejectedTransition.attempt : currentAttempt;
    if (rejectedTransition.ok) {
      await persistence.removeSubmissionAttempt(ownerUid);
    }
    return { outcome: "REJECTED", category: classification.category, reason: classification.reason, attempt: nextAttempt };
  }

  // UNKNOWN: preserve exact key/content, keep it persisted, never clear it.
  const unknownTransition = markUnknown(currentAttempt, classification.reason);
  const nextAttempt = unknownTransition.ok ? unknownTransition.attempt : currentAttempt;
  if (unknownTransition.ok) {
    await persistence.saveSubmissionAttempt(ownerUid, nextAttempt);
  }
  return { outcome: "UNKNOWN", category: classification.category, reason: classification.reason, attempt: nextAttempt };
}

/**
 * Shared core: given an attempt already in IN_FLIGHT status, persists
 * it write-ahead, then (only on persistence success) invokes the
 * backend and classifies the result.
 */
async function persistThenCall(currentAttempt, { ownerUid, persistence, callOrderIntent }) {
  const persistResult = await persistPendingAttempt(persistence, ownerUid, currentAttempt);
  if (!persistResult.ok) {
    // WRITE-AHEAD SAFETY: the network call never happens. No new key
    // is generated. State is not reset to IDLE - the attempt (still
    // IN_FLIGHT in memory) is handed back to the caller unchanged.
    return {
      outcome: "BLOCKED",
      category: "PERSISTENCE_FAILED",
      reason: persistResult.code,
      attempt: currentAttempt,
    };
  }

  const payload = buildOrderIntentRequestPayload(currentAttempt);

  let rawResult;
  try {
    rawResult = await callOrderIntent(payload);
  } catch (err) {
    return handleCallableError(err, currentAttempt, ownerUid, persistence);
  }

  return handleCallableSuccess(rawResult, currentAttempt, ownerUid, persistence);
}

/**
 * Begins a brand-new logical submission and drives it through the
 * write-ahead-persist -> network call -> classify sequence.
 *
 * @param {Object} params
 * @param {Array} params.items
 * @param {string|null} params.customerName
 * @param {string|null} params.notes
 * @param {string} params.ownerUid
 * @param {Object} params.persistence - injected persistence dependency
 * @param {(payload: Object) => Promise<{data: Object}>} params.callOrderIntent - injected callable
 * @param {{generateKey?: () => string}} [deps]
 */
async function submitNewAttempt(params, deps) {
  const beginResult = beginSubmission(
    null,
    {
      items: params.items,
      customerName: params.customerName,
      notes: params.notes,
      ownerUid: params.ownerUid,
    },
    deps
  );
  if (!beginResult.ok) {
    return { outcome: "BLOCKED", category: "CANNOT_BEGIN", reason: beginResult.code, attempt: beginResult.state };
  }

  return persistThenCall(beginResult.attempt, params);
}

/**
 * Recovers an UNKNOWN attempt: transitions it back to IN_FLIGHT with
 * the SAME idempotencyKey and SAME content (never rebuilt from a live
 * Cart), then drives the same write-ahead-persist -> call -> classify
 * sequence. There is no code path anywhere that mints a new key here.
 *
 * @param {Object} params
 * @param {Object} params.attempt - the existing UNKNOWN SubmissionAttempt
 * @param {string} params.ownerUid
 * @param {Object} params.persistence
 * @param {(payload: Object) => Promise<{data: Object}>} params.callOrderIntent
 */
async function retryUnknownAttempt(params) {
  const retryTransition = retry(params.attempt);
  if (!retryTransition.ok) {
    return { outcome: "BLOCKED", category: "CANNOT_RETRY", reason: retryTransition.code, attempt: params.attempt };
  }

  return persistThenCall(retryTransition.attempt, params);
}

module.exports = {
  submitNewAttempt,
  retryUnknownAttempt,
};
