"use strict";

/**
 * Kiosk Customer Session runtime - pure lifecycle bookkeeping plus a
 * guarded, injected-dependency reset orchestration. No Firebase, no
 * IndexedDB, no OrderIntent network call, no Cart reducer, no AWR, no
 * payment provider, no UI/DOM.
 *
 * Two layers, deliberately kept separate:
 *
 *   applyEvent(state, event) - pure (state, event) -> next state, for
 *     the four "cheap" lifecycle facts that never need injected
 *     dependencies: FIRST_CART_ITEM_ADDED, SUBMISSION_STARTED,
 *     AUTHORITATIVE_RESULT_AVAILABLE, SUBMISSION_REJECTED.
 *
 *   requestSessionEnd(params) - the ONLY entrypoint for anything
 *     disengagement/cancel/reset-related. Always runs a state-eligibility
 *     check, then the ambiguity guard, BEFORE any destructive operation;
 *     if either fails, NONE of clearCart/clearTerminalSubmission/
 *     clearAuthoritativeResult/purgePersistence/requestAuthReset are
 *     ever invoked. There is no other way to reach requestAuthReset in
 *     this module - it is never exposed as a standalone callable a
 *     caller could invoke directly, bypassing the guard.
 *
 * This module is authority for "is this Customer Session allowed to
 * end" - it is NOT authority for "did the order succeed," "was payment
 * successful," "is stock available," or "how much is the order." Those
 * remain Cart/Submission/OrderIntent/future-Payment domains' own
 * authority, observed here only through supplied context fields.
 */

const { SessionStates, EventTypes, AMBIGUOUS_SUBMISSION_STATUSES, RESET_STEPS } = require("./sessionTypes");

const { IDLE, ACTIVE, AWAITING_OUTCOME, CONFIRMATION } = SessionStates;

function illegal(state) {
  return { ok: false, code: "ILLEGAL_TRANSITION", state };
}

/**
 * Pure lifecycle transition. Unknown/illegal events leave state
 * unchanged (same primitive value, trivially "unchanged" for a string).
 */
function applyEvent(state, event) {
  const currentState = state === undefined ? IDLE : state;
  if (!event || typeof event.type !== "string") return illegal(currentState);

  switch (event.type) {
    case EventTypes.FIRST_CART_ITEM_ADDED:
      if (currentState === IDLE) return { ok: true, state: ACTIVE };
      if (currentState === ACTIVE) return { ok: true, state: ACTIVE }; // idempotent - no second session
      return illegal(currentState);

    case EventTypes.SUBMISSION_STARTED:
      if (currentState === ACTIVE) return { ok: true, state: AWAITING_OUTCOME };
      return illegal(currentState);

    case EventTypes.AUTHORITATIVE_RESULT_AVAILABLE:
      if (currentState === AWAITING_OUTCOME) return { ok: true, state: CONFIRMATION };
      return illegal(currentState);

    case EventTypes.SUBMISSION_REJECTED:
      // Backend proved no commit occurred (STEP 46 S14) - the customer
      // may keep adjusting/retrying the Cart.
      if (currentState === AWAITING_OUTCOME) return { ok: true, state: ACTIVE };
      return illegal(currentState);

    default:
      return illegal(currentState);
  }
}

/**
 * THE central safety invariant of this module. Session End must be
 * blocked whenever the submission outcome is unresolved, and must be
 * extensible to future Payment ambiguity without implementing Payment
 * now.
 */
function canEndSession(context) {
  const safeContext = context || {};
  if (AMBIGUOUS_SUBMISSION_STATUSES.includes(safeContext.submissionStatus)) {
    return { allowed: false, reason: "SUBMISSION_OUTCOME_AMBIGUOUS" };
  }
  if (safeContext.paymentOutcomeAmbiguous) {
    return { allowed: false, reason: "PAYMENT_OUTCOME_AMBIGUOUS" };
  }
  return { allowed: true };
}

/**
 * Derives the initial Session lifecycle state from already-hydrated
 * persisted facts (STEP 61/62). This is NOT a live customer event - it
 * reconstructs a starting phase from storage, and deliberately does NOT
 * go through applyEvent() and does NOT fabricate a FIRST_CART_ITEM_ADDED
 * or SUBMISSION_STARTED event that never actually happened live. Session
 * lifecycle events remain live-only; this function is a separate,
 * smaller concept: "what phase does this persisted snapshot represent,"
 * not "what event just occurred."
 *
 * Precedence (STEP 61 S3, STEP 62 S3 - locked order for this function):
 *   1. hasAuthoritativeResult -> CONFIRMATION. A persisted authoritative
 *      result is proof the backend already committed successfully for
 *      its idempotencyKey (STEP 61A Issue A) and takes precedence over
 *      any coexisting stale/unresolved SubmissionAttempt. The caller is
 *      responsible for having already reconciled a same-idempotencyKey
 *      match before calling this with hasAuthoritativeResult true while
 *      an unresolved attempt also exists; a genuine key mismatch is a
 *      caller-level hydration anomaly, never guessed at here - this
 *      function only ever sees the single boolean the caller decided.
 *   2. an unresolved SubmissionAttempt (IN_FLIGHT or UNKNOWN) exists
 *      -> AWAITING_OUTCOME.
 *   3. no unresolved submission and the Cart has at least one line
 *      -> ACTIVE.
 *   4. otherwise -> IDLE.
 *
 * @param {{hasAuthoritativeResult?: boolean, submissionStatus?: string|null, cartHasLines?: boolean}} [facts]
 * @returns {string} one of SessionStates
 */
function deriveInitialSessionState(facts) {
  const safeFacts = facts || {};
  if (safeFacts.hasAuthoritativeResult) return CONFIRMATION;
  if (AMBIGUOUS_SUBMISSION_STATUSES.includes(safeFacts.submissionStatus)) return AWAITING_OUTCOME;
  if (safeFacts.cartHasLines) return ACTIVE;
  return IDLE;
}

function eligibleStatesFor(eventType) {
  return eventType === EventTypes.CUSTOMER_CANCELLED ? [ACTIVE] : [CONFIRMATION];
}

/**
 * Guarded reset orchestration. Every external capability is an
 * injected, optional callback:
 *   stopInteraction, clearCart, clearTerminalSubmission,
 *   clearAuthoritativeResult, purgePersistence, resetSession,
 *   requestAuthReset, neutralIdle.
 * None are hard-imported; a missing callback is treated as a no-op
 * step, never as a failure.
 *
 * @param {Object} params
 * @param {{type: string}} params.event - one of the EventTypes
 * @param {string} params.currentState - one of SessionStates
 * @param {string|null|undefined} params.submissionStatus - current SubmissionAttempt status, if any
 * @param {boolean} [params.paymentOutcomeAmbiguous] - future Payment extension point, defaults false
 * @param {Object} [params.deps] - injected reset callbacks
 */
async function requestSessionEnd(params) {
  const safeParams = params || {};
  const deps = safeParams.deps || {};
  const event = safeParams.event || {};
  const currentState = safeParams.currentState;
  const callLog = [];

  const eligibleStates = eligibleStatesFor(event.type);
  if (!eligibleStates.includes(currentState)) {
    return { outcome: "BLOCKED", reason: "NOT_END_ELIGIBLE_STATE", state: currentState, callLog };
  }

  if (deps.stopInteraction) {
    callLog.push("stopInteraction");
    await deps.stopInteraction();
  }

  callLog.push("ambiguityGuard");
  const guard = canEndSession({
    submissionStatus: safeParams.submissionStatus,
    paymentOutcomeAmbiguous: safeParams.paymentOutcomeAmbiguous,
  });
  if (!guard.allowed) {
    // NONE of the destructive operations below may run - this is the
    // revised STEP 55/56 safety baseline (STEP 59 S22).
    return { outcome: "BLOCKED", reason: guard.reason, state: currentState, callLog };
  }

  const failures = [];
  for (const step of RESET_STEPS) {
    const fn = deps[step.dep];
    if (!fn) continue; // no dependency supplied: treated as a no-op, never a failure
    callLog.push(step.dep);
    try {
      const result = await fn();
      if (result && result.ok === false) {
        failures.push({ step: step.dep, code: step.failureCode, detail: result });
      }
    } catch (error) {
      failures.push({ step: step.dep, code: step.failureCode, detail: error });
    }
  }

  if (failures.length > 0) {
    // Reset failure safety: never claim SESSION_ENDED if customer-
    // specific state may still be active, and Auth Reset must NOT be
    // attempted at all if any prior step failed.
    return { outcome: "RESET_INCOMPLETE", reason: failures, state: currentState, callLog };
  }

  if (deps.resetSession) {
    callLog.push("resetSession");
    await deps.resetSession();
  }

  if (deps.requestAuthReset) {
    callLog.push("requestAuthReset");
    try {
      await deps.requestAuthReset();
    } catch (error) {
      // Auth reset failure is represented explicitly, distinct from a
      // customer-data reset failure - customer data is already clean
      // at this point, but identity rotation did not complete.
      return {
        outcome: "RESET_INCOMPLETE",
        reason: [{ step: "requestAuthReset", code: "AUTH_RESET_FAILED", detail: error }],
        state: currentState,
        callLog,
      };
    }
  }

  if (deps.neutralIdle) {
    callLog.push("neutralIdle");
    await deps.neutralIdle();
  }

  return { outcome: "SESSION_ENDED", state: IDLE, callLog };
}

module.exports = {
  SessionStates,
  EventTypes,
  applyEvent,
  canEndSession,
  deriveInitialSessionState,
  requestSessionEnd,
};
