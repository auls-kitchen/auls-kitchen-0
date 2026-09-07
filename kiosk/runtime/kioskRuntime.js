"use strict";

/**
 * Kiosk Runtime Coordinator - the composition layer STEP 60/61/61A
 * discovered as justified and scoped. This module is GLUE ONLY: it holds
 * the composed runtime state (cartState, submissionState, sessionState,
 * authoritativeResult, ownerUid) and translates between the five
 * independent Kiosk modules' own shapes. It never computes price, HPP,
 * recipe, or stock; never decides OrderIntent or payment success; never
 * calls Firestore/Firebase Auth/httpsCallable directly; and never
 * reimplements a rule that already belongs to one of the five modules.
 *
 * Hard dependency boundary (mirrors every other Kiosk module): NO
 * Firebase, NO Firestore, NO IndexedDB, NO DOM, NO real Auth SDK. This
 * file requires only the five actual Kiosk modules' pure/composition
 * entrypoints; `persistence`, `callOrderIntent`, `requestAuthReset`,
 * `stopInteraction`, and `neutralIdle` are all received as injected
 * dependencies from the caller (the real caller wires a real
 * IndexedDB-backed persistence adapter and a real
 * httpsCallable(functions, "orderIntent") wrapper - this module never
 * constructs either itself).
 */

const { createEmptyCartDraft } = require("../cart/cartTypes");
const {
  cartReducer,
  addItem: buildAddItemAction,
  incrementLine: buildIncrementLineAction,
  decrementLine: buildDecrementLineAction,
  removeLine: buildRemoveLineAction,
  setLineModifiers: buildSetLineModifiersAction,
  setCustomerName: buildSetCustomerNameAction,
  setNotes: buildSetNotesAction,
  clearCart: buildClearCartAction,
} = require("../cart/cartReducer");
const { Status: SubmissionStatus } = require("../submission/submissionTypes");
const { markUnknown, clearTerminalAttempt } = require("../submission/submissionMachine");
const { submitNewAttempt, retryUnknownAttempt } = require("../orderIntent/orderIntentAdapter");
const { ResultCodes } = require("../persistence/persistenceTypes");
const {
  SessionStates,
  EventTypes,
  applyEvent,
  requestSessionEnd,
  deriveInitialSessionState,
} = require("../session/sessionMachine");

/**
 * Creates a Kiosk Runtime instance bound to the given injected
 * dependencies.
 *
 * @param {Object} deps
 * @param {Object} deps.persistence - REQUIRED. Matches the actual
 *   createPersistenceAdapter(store) return shape (saveCartDraft,
 *   saveSubmissionAttempt, saveAuthoritativeResult,
 *   removeSubmissionAttempt, removeAuthoritativeResult,
 *   purgeCustomerContext, load).
 * @param {(payload: Object) => Promise<{data: Object}>} deps.callOrderIntent
 *   - REQUIRED. The thin callable wrapper the real caller builds from
 *   httpsCallable(functions, "orderIntent"). This module only ever
 *   invokes it as an opaque async function, never constructs it.
 * @param {() => Promise<void>} [deps.requestAuthReset] - OPTIONAL
 *   (missing = safe no-op, per sessionMachine.js's own contract). Real
 *   Auth SDK rotation is NOT implemented here - this stays an injected
 *   callback the real caller supplies.
 * @param {() => Promise<void>} [deps.stopInteraction] - OPTIONAL UI hook.
 * @param {() => Promise<void>} [deps.neutralIdle] - OPTIONAL UI hook.
 * @param {() => string} [deps.generateKey] - OPTIONAL, test-only
 *   determinism override threaded through to submitNewAttempt/
 *   retryUnknownAttempt; production omits it and each module's own
 *   default generator applies.
 */
function createKioskRuntime(deps) {
  const safeDeps = deps || {};
  const persistence = safeDeps.persistence;
  const callOrderIntent = safeDeps.callOrderIntent;
  const requestAuthResetDep = safeDeps.requestAuthReset;
  const stopInteractionDep = safeDeps.stopInteraction;
  const neutralIdleDep = safeDeps.neutralIdle;
  const generateKey = safeDeps.generateKey;
  const adapterDeps = generateKey ? { generateKey } : undefined;

  let ownerUid = null;
  let cartState = createEmptyCartDraft();
  let submissionState = null;
  let sessionState = SessionStates.IDLE;
  let authoritativeResult = null;
  let hydrated = false;

  /**
   * Startup hydration. Calls the injected persistence's own load()
   * exactly as documented (STEP 55/56) - no invented expiry duration,
   * no default threshold; expiryOptions is passed through untouched.
   *
   * Non-VALID load() outcomes (EMPTY, UID_MISMATCH, CORRUPT_RECORD,
   * UNSUPPORTED_SCHEMA, READ_FAILURE) are all treated the same way:
   * nothing is safely hydratable, so Runtime starts fresh/IDLE. This
   * never invents automatic foreign-record deletion (UID_MISMATCH) and
   * never pretends a corrupt/unreadable record was resolved - the
   * original persistence result (including any `error`/
   * `foundSchemaVersion` field) is passed straight through to the
   * caller for visibility.
   */
  async function hydrate(currentOwnerUid, expiryOptions) {
    ownerUid = currentOwnerUid;
    const loaded = await persistence.load(currentOwnerUid, expiryOptions);

    if (loaded.status !== ResultCodes.VALID) {
      cartState = createEmptyCartDraft();
      submissionState = null;
      authoritativeResult = null;
      sessionState = SessionStates.IDLE;
      hydrated = true;
      return Object.assign({}, loaded, { sessionState });
    }

    cartState = loaded.cartDraft || createEmptyCartDraft();
    let hydratedSubmission = loaded.submissionAttempt || null;
    const hydratedResult = loaded.authoritativeResult || null;
    let anomaly = null;

    // STEP 62 S3/S11(D): a persisted IN_FLIGHT attempt is itself evidence
    // of a prior crash/reload mid-network-call. submissionMachine.retry()
    // only accepts UNKNOWN, so the ONLY recovery path is the existing
    // markUnknown() transition - there is no alternate path invented here.
    if (hydratedSubmission && hydratedSubmission.status === SubmissionStatus.IN_FLIGHT) {
      const unknownTransition = markUnknown(hydratedSubmission, "HYDRATED_IN_FLIGHT_UNVERIFIED");
      if (!unknownTransition.ok) {
        return { status: "HYDRATION_ANOMALY", reason: "IN_FLIGHT_TRANSITION_FAILED" };
      }
      hydratedSubmission = unknownTransition.attempt;
    }

    // STEP 61A Issue A - the ONLY authorized interim reconciliation:
    // saveAuthoritativeResult() and removeSubmissionAttempt() inside
    // orderIntentAdapter.js are two separate, non-atomic writes, so a
    // crash between them can leave a stale unresolved submissionAttempt
    // coexisting with a valid authoritativeResult for the SAME key.
    // saveAuthoritativeResult has exactly one call site in this codebase
    // (orderIntentAdapter.js's handleCallableSuccess) and is reached only
    // after a validated backend success response - so a MATCHING key
    // proves the backend already committed; retry is therefore forbidden
    // and the result is treated as terminal. A NON-matching key is a
    // genuine anomaly this function does not guess at - both records are
    // preserved and surfaced, and the session is derived conservatively
    // (as if no usable result exists for THIS submission), never as
    // CONFIRMATION. The permanent fix (an atomic combined Persistence
    // write) is explicitly out of scope here - this is an interim,
    // narrowly-conditional recovery rule only.
    let resultAppliesToSubmission = false;
    if (hydratedResult && hydratedSubmission) {
      if (hydratedSubmission.idempotencyKey === hydratedResult.idempotencyKey) {
        resultAppliesToSubmission = true;
        try {
          await persistence.removeSubmissionAttempt(ownerUid);
        } catch (error) {
          // Best-effort interim cleanup only - a failure here does not
          // block hydration; the same reconciliation will simply be
          // repeated (harmlessly) on the next hydration.
        }
        hydratedSubmission = null;
      } else {
        anomaly = {
          reason: "SUBMISSION_RESULT_KEY_MISMATCH",
          submissionAttempt: hydratedSubmission,
          authoritativeResult: hydratedResult,
        };
      }
    }

    submissionState = hydratedSubmission;
    authoritativeResult = hydratedResult;
    sessionState = deriveInitialSessionState({
      hasAuthoritativeResult: !!hydratedResult && (resultAppliesToSubmission || !hydratedSubmission),
      submissionStatus: submissionState ? submissionState.status : null,
      cartHasLines: cartState.lines.length > 0,
    });

    hydrated = true;
    return anomaly
      ? Object.assign({ status: "HYDRATION_ANOMALY" }, anomaly, { sessionState })
      : { status: "VALID", sessionState };
  }

  function maybeStartSessionFromCart() {
    if (sessionState === SessionStates.IDLE && cartState.lines.length > 0) {
      const result = applyEvent(sessionState, { type: EventTypes.FIRST_CART_ITEM_ADDED });
      if (result.ok) sessionState = result.state;
    }
  }

  function addItemAction(input) {
    cartState = cartReducer(cartState, buildAddItemAction(input));
    maybeStartSessionFromCart();
    return cartState;
  }
  function incrementLineAction(localLineId) {
    cartState = cartReducer(cartState, buildIncrementLineAction(localLineId));
    return cartState;
  }
  function decrementLineAction(localLineId) {
    cartState = cartReducer(cartState, buildDecrementLineAction(localLineId));
    return cartState;
  }
  function removeLineAction(localLineId) {
    cartState = cartReducer(cartState, buildRemoveLineAction(localLineId));
    return cartState;
  }
  function setLineModifiersAction(localLineId, selectedModifiers) {
    cartState = cartReducer(cartState, buildSetLineModifiersAction(localLineId, selectedModifiers));
    return cartState;
  }
  function setCustomerNameAction(customerName) {
    cartState = cartReducer(cartState, buildSetCustomerNameAction(customerName));
    return cartState;
  }
  function setNotesAction(notes) {
    cartState = cartReducer(cartState, buildSetNotesAction(notes));
    return cartState;
  }
  function clearCartAction() {
    cartState = cartReducer(cartState, buildClearCartAction());
    return cartState;
  }

  /**
   * Cart -> Submission translation (STEP 62 S6): a CartLine's
   * localLineId (UI-only identity) and displaySnapshot (non-authoritative
   * presentation cache) are dropped entirely - only productId/quantity/
   * selectedModifiers ever reach Submission/OrderIntent.
   */
  function translateCartLinesToItems(lines) {
    return lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      selectedModifiers: line.selectedModifiers,
    }));
  }

  function applySuccessOutcome(result) {
    authoritativeResult = submissionState.authoritativeResult;
    submissionState = null;
    const doneResult = applyEvent(sessionState, { type: EventTypes.AUTHORITATIVE_RESULT_AVAILABLE });
    if (doneResult.ok) sessionState = doneResult.state;
  }

  function applyRejectedOrCannotBeginOutcome() {
    submissionState = null;
    const recoverResult = applyEvent(sessionState, { type: EventTypes.SUBMISSION_REJECTED });
    if (recoverResult.ok) sessionState = recoverResult.state;
  }

  /**
   * Begins a brand-new submission. Uses ONLY orderIntentAdapter.js's
   * submitNewAttempt() - this module never reproduces its internal
   * persist-then-call sequencing (STEP 62 S7).
   *
   * SUBMISSION_STARTED is dispatched SYNCHRONOUSLY, before any await -
   * this is what makes Session's eligibility check (not the ambiguity
   * guard) block a concurrent Session End attempt during the in-flight
   * window, satisfying STEP 61 Scenario 5 without needing submissionState
   * to already hold a real attempt object at that instant.
   */
  async function submit(input) {
    if (submissionState !== null) {
      return { outcome: "BLOCKED", category: "SUBMISSION_ALREADY_ACTIVE", attempt: submissionState };
    }
    if (cartState.lines.length === 0) {
      return { outcome: "BLOCKED", category: "EMPTY_CART", attempt: null };
    }

    const startResult = applyEvent(sessionState, { type: EventTypes.SUBMISSION_STARTED });
    if (!startResult.ok) {
      return { outcome: "BLOCKED", category: "SESSION_NOT_ELIGIBLE", attempt: null };
    }
    sessionState = startResult.state;

    const items = translateCartLinesToItems(cartState.lines);
    const customerName = input && "customerName" in input ? input.customerName : cartState.customerName;
    const notes = input && "notes" in input ? input.notes : cartState.notes;

    const result = await submitNewAttempt(
      { items, customerName, notes, ownerUid, persistence, callOrderIntent },
      adapterDeps
    );

    submissionState = result.attempt || null;

    if (result.outcome === "SUCCEEDED") {
      applySuccessOutcome(result);
    } else if (result.outcome === "REJECTED" || (result.outcome === "BLOCKED" && result.category === "CANNOT_BEGIN")) {
      // CANNOT_BEGIN means no attempt was ever actually created (e.g. key
      // generation failed) even though SUBMISSION_STARTED already fired -
      // reusing the existing SUBMISSION_REJECTED event (documented as "no
      // commit occurred, customer may retry") is the correct, already-
      // available recovery; this invents no new event or session state.
      applyRejectedOrCannotBeginOutcome();
    }
    // UNKNOWN, or BLOCKED/PERSISTENCE_FAILED: submissionState reflects
    // exactly what the adapter returned; sessionState stays
    // AWAITING_OUTCOME - no event exists for these outcomes (STEP 61 S8/S9).

    return result;
  }

  /**
   * Recovers an UNKNOWN attempt. Legal only when submissionState is
   * currently UNKNOWN (a hydrated IN_FLIGHT must already have passed
   * through hydrate()'s markUnknown() translation - there is no
   * alternate recovery path, per STEP 62 S10).
   */
  async function retryUnknown() {
    if (submissionState === null || submissionState.status !== SubmissionStatus.UNKNOWN) {
      return { outcome: "BLOCKED", category: "CANNOT_RETRY", attempt: submissionState };
    }

    const result = await retryUnknownAttempt({ attempt: submissionState, ownerUid, persistence, callOrderIntent });
    submissionState = result.attempt || null;

    if (result.outcome === "SUCCEEDED") {
      applySuccessOutcome(result);
    } else if (result.outcome === "REJECTED") {
      applyRejectedOrCannotBeginOutcome();
    }
    // UNKNOWN / BLOCKED: stays AWAITING_OUTCOME, same as submit().

    return result;
  }

  /**
   * Session End composition (STEP 62 S13/S14). requestSessionEnd()
   * remains fully authoritative for eligibility, the ambiguity guard,
   * reset ordering, and Auth-reset ordering - Runtime supplies only the
   * named callbacks and holds the composed state they act on.
   */
  async function endSession(eventType) {
    const sessionDeps = {
      stopInteraction: stopInteractionDep,
      clearCart: async () => {
        cartState = createEmptyCartDraft();
        return { ok: true };
      },
      clearTerminalSubmission: async () => {
        const result = clearTerminalAttempt(submissionState);
        if (!result.ok) return { ok: false, code: result.code };
        submissionState = result.attempt;
        return { ok: true };
      },
      clearAuthoritativeResult: async () => {
        authoritativeResult = null;
        const removeResult = await persistence.removeAuthoritativeResult(ownerUid);
        if (removeResult && removeResult.ok === false) return { ok: false, code: removeResult.code };
        return { ok: true };
      },
      purgePersistence: async () => persistence.purgeCustomerContext(),
      // STEP 61 S6: resetSession is informationally redundant with
      // requestSessionEnd()'s own returned {state: IDLE} - sessionMachine.js
      // holds no state of its own to reset. This closure is the
      // orchestration seam: it lets sessionState already read IDLE at the
      // correct point in the locked sequence (before requestAuthReset/
      // neutralIdle), not only after the whole call resolves.
      resetSession: async () => {
        sessionState = SessionStates.IDLE;
        return { ok: true };
      },
      requestAuthReset: requestAuthResetDep,
      neutralIdle: neutralIdleDep,
    };

    let result;
    try {
      result = await requestSessionEnd({
        event: { type: eventType },
        currentState: sessionState,
        submissionStatus: submissionState ? submissionState.status : null,
        deps: sessionDeps,
      });
    } catch (error) {
      // STEP 61A Issue B: requestSessionEnd's own stopInteraction/
      // neutralIdle calls are not wrapped in try/catch internally, so a
      // throw can escape as an unhandled rejection. Runtime defensively
      // catches its OWN call here and NEVER treats an exception as
      // SESSION_ENDED - sessionMachine.js itself is not modified.
      return {
        outcome: "RESET_INCOMPLETE",
        reason: [{ step: "unknown", code: "UNEXPECTED_THROW", detail: error }],
        state: sessionState,
      };
    }

    if (result.outcome === "SESSION_ENDED") {
      sessionState = result.state;
      cartState = createEmptyCartDraft();
      submissionState = null;
      authoritativeResult = null;
    }
    // BLOCKED / RESET_INCOMPLETE: Runtime state is left exactly as it was
    // wherever the guarded sequence stopped - never reports success.

    return result;
  }

  /**
   * Read-only, customer-safe snapshot for UI composition (STEP 62 S17).
   * Never exposes persistence, the Auth callback, the OrderIntent
   * callable, or ownerUid.
   */
  function getSnapshot() {
    return {
      cart: cartState,
      submission: submissionState,
      session: sessionState,
      authoritativeResult: authoritativeResult,
      hydrated: hydrated,
    };
  }

  return {
    hydrate,
    addItem: addItemAction,
    incrementLine: incrementLineAction,
    decrementLine: decrementLineAction,
    removeLine: removeLineAction,
    setLineModifiers: setLineModifiersAction,
    setCustomerName: setCustomerNameAction,
    setNotes: setNotesAction,
    clearCart: clearCartAction,
    submit,
    retryUnknown,
    requestSessionEnd: endSession,
    getSnapshot,
  };
}

module.exports = { createKioskRuntime, SessionStates, EventTypes };
