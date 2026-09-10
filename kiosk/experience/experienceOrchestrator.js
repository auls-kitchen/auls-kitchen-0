"use strict";

/**
 * Kiosk Experience Orchestrator (STEP 72) - the adapter/bridge that
 * decides WHEN to call STEP 70's semantic event creation helpers and
 * emit through the STEP 70 event bus, based on STEP 71's evidence-based
 * discovery of exactly which Runtime actions/state transitions/action
 * results justify each of the five LOCKED events.
 *
 * This module is NOT a Runtime replacement and NOT a second business
 * state machine. It holds exactly one piece of ephemeral memory -
 * `lastEmittedOrderStatus` - used ONLY to detect whether the semantic
 * order status actually changed since the last observation, so
 * ORDER_OUTCOME_CHANGED is never emitted twice for an unchanged status
 * (e.g. an UNKNOWN retry that remains UNKNOWN). This memo is never read
 * by, written back into, or otherwise capable of influencing Runtime in
 * any way - it is a one-directional diffing aid, not authority.
 *
 * Dependency injection only: createExperienceOrchestrator({runtime,
 * eventBus}) takes an already-constructed Runtime instance (from
 * kiosk/runtime/kioskRuntime.js's createKioskRuntime) and an
 * already-constructed event bus (from experienceEventBus.js's
 * createEventBus) - this module never constructs either itself, never
 * imports kiosk/runtime, kiosk/cart, kiosk/persistence, kiosk/submission,
 * kiosk/orderIntent, or kiosk/session, and has no global singleton: every
 * call to createExperienceOrchestrator produces a fully independent
 * instance.
 *
 * Every method here does exactly one of three things: (1) call a Runtime
 * action and inspect its already-computed return value/resulting
 * snapshot, (2) call STEP 69's projection functions to derive a
 * customer-safe view, (3) call STEP 70's event-creation helpers and the
 * event bus. It never generates an idempotency key, never decides order/
 * payment/session-end success independently, never mutates stock or
 * Firestore, never performs a network call itself, and never bypasses a
 * Runtime guard - every guard remains Runtime's own, re-checked by
 * Runtime at the moment each action actually runs, regardless of
 * anything this module does or doesn't do beforehand.
 */

const { projectExperienceSnapshot, projectOrderOutcomeFromActionResult } = require("./experienceProjection");
const {
  createSessionStartedEvent,
  createSubmissionStartedEvent,
  createOrderOutcomeChangedEvent,
  createAnomalyDetectedEvent,
  createSessionEndedEvent,
} = require("./experienceEvents");
const { OrderStatus, SessionPhase } = require("./experienceTypes");

// The exact three categories Runtime's own submit() returns when it
// refused BEFORE ever dispatching Session's internal SUBMISSION_STARTED
// transition (kiosk/runtime/kioskRuntime.js, re-verified this step) - a
// real submission attempt never began in any of these three cases, so no
// SUBMISSION_STARTED event is warranted for them.
const SUBMIT_PRE_DISPATCH_BLOCK_CATEGORIES = Object.freeze([
  "SUBMISSION_ALREADY_ACTIVE",
  "EMPTY_CART",
  "SESSION_NOT_ELIGIBLE",
]);

// Only these ORDER statuses represent a meaningful "outcome changed"
// moment worth a semantic event (STEP 71 S7/S8) - NONE/PENDING are
// tracked in the dedup memo but never themselves emitted as an event.
const MEANINGFUL_ORDER_STATUSES = Object.freeze([OrderStatus.UNCERTAIN, OrderStatus.CONFIRMED, OrderStatus.DECLINED]);

function createExperienceOrchestrator(deps) {
  const safeDeps = deps || {};
  if (!safeDeps.runtime) {
    throw new TypeError("createExperienceOrchestrator requires a `runtime` dependency");
  }
  if (!safeDeps.eventBus) {
    throw new TypeError("createExperienceOrchestrator requires an `eventBus` dependency");
  }
  const runtime = safeDeps.runtime;
  const eventBus = safeDeps.eventBus;

  // The ONLY piece of orchestrator-held memory - see module header.
  // Starts at NONE, matching a fresh Runtime's own default order state.
  let lastEmittedOrderStatus = OrderStatus.NONE;

  /**
   * Updates the dedup memo to the newly-observed status UNCONDITIONALLY
   * (whether or not an event is emitted for it - STEP 72 S20), then
   * emits ORDER_OUTCOME_CHANGED only if the status is one of the
   * meaningful ones AND differs from what was last observed.
   */
  function observeOrderOutcome(projectedOrder) {
    const nextStatus = projectedOrder && projectedOrder.status;
    const changed = nextStatus !== lastEmittedOrderStatus;
    if (changed && MEANINGFUL_ORDER_STATUSES.includes(nextStatus)) {
      const event = createOrderOutcomeChangedEvent(projectedOrder);
      if (event) eventBus.emit(event);
    }
    lastEmittedOrderStatus = nextStatus;
  }

  function currentSnapshot() {
    return projectExperienceSnapshot(runtime.getSnapshot());
  }

  // --- Cart actions: plain pass-through + customer-safe snapshot read ---
  // None of these ever call maybeStartSessionFromCart-equivalent logic
  // themselves - Session Start detection lives ONLY in addItem() below,
  // via before/after comparison of Runtime's OWN already-computed session
  // phase, never by this module independently inspecting Cart length.

  function addItem(input) {
    const before = currentSnapshot();
    runtime.addItem(input);
    const after = currentSnapshot();
    if (before.session === SessionPhase.IDLE && after.session === SessionPhase.ACTIVE) {
      eventBus.emit(createSessionStartedEvent());
    }
    return after.cart;
  }

  function incrementLine(lineRef) {
    // lineRef is the exact same string ExperienceSnapshot's cart.lines[]
    // exposes as `lineRef` (itself a rename of Cart's own `localLineId`,
    // not a transformed value) - passing it straight through to Runtime
    // is correct, not a coincidence.
    runtime.incrementLine(lineRef);
    return currentSnapshot().cart;
  }

  function decrementLine(lineRef) {
    runtime.decrementLine(lineRef);
    return currentSnapshot().cart;
  }

  function removeLine(lineRef) {
    runtime.removeLine(lineRef);
    return currentSnapshot().cart;
  }

  function setLineModifiers(lineRef, selectedModifiers) {
    runtime.setLineModifiers(lineRef, selectedModifiers);
    return currentSnapshot().cart;
  }

  function setCustomerName(customerName) {
    runtime.setCustomerName(customerName);
    return currentSnapshot().cart;
  }

  function setNotes(notes) {
    runtime.setNotes(notes);
    return currentSnapshot().cart;
  }

  function clearCart() {
    runtime.clearCart();
    return currentSnapshot().cart;
  }

  /**
   * Explicit customer commit action. Emits SUBMISSION_STARTED once,
   * after resolution, only when Runtime's own submit() got past all
   * three of its pre-dispatch guards (i.e. a real attempt genuinely
   * began) - never before calling submit(), and never for retry
   * (see retryUnknown() below). Reuses STEP 69's
   * projectOrderOutcomeFromActionResult() for the outcome translation -
   * no rejection-mapping or result-sanitization logic is duplicated here.
   */
  async function submit(input) {
    let result;
    try {
      result = await runtime.submit(input);
    } catch (_error) {
      // Defensive only - the actual Runtime contract does not throw here
      // under normal operation (STEP 62). If it ever did, this module
      // must not fabricate any outcome, must not emit any event, and
      // must not expose the raw error - so it does none of those things.
      return { outcome: "ORCHESTRATION_ERROR", order: null };
    }

    const projectedOrder = projectOrderOutcomeFromActionResult(result);
    const wasDispatched = !(result.outcome === "BLOCKED" && SUBMIT_PRE_DISPATCH_BLOCK_CATEGORIES.includes(result.category));

    if (wasDispatched) {
      eventBus.emit(createSubmissionStartedEvent());
      observeOrderOutcome(projectedOrder);
    }

    return { outcome: result.outcome, order: projectedOrder };
  }

  /**
   * Recovers an UNKNOWN attempt. Deliberately NEVER emits
   * SUBMISSION_STARTED - Runtime's own retryUnknown() never dispatches
   * an equivalent Session transition either (re-verified this step), and
   * the approved five-event vocabulary has no separate RETRY_STARTED
   * event (STEP 71 S6/S14, LOCKED).
   */
  async function retryUnknown() {
    let result;
    try {
      result = await runtime.retryUnknown();
    } catch (_error) {
      return { outcome: "ORCHESTRATION_ERROR", order: null };
    }

    const projectedOrder = projectOrderOutcomeFromActionResult(result);
    observeOrderOutcome(projectedOrder);

    return { outcome: result.outcome, order: projectedOrder };
  }

  /**
   * Startup hydration. Reads the resulting snapshot through STEP 69's
   * projection and:
   *   - emits ANOMALY_DETECTED if the snapshot is degraded (the genuine
   *     hydration-mismatch case only - STEP 71 S11/S17);
   *   - emits ORDER_OUTCOME_CHANGED(UNCERTAIN) ONLY when the resulting
   *     order status is the non-terminal UNCERTAIN - a reconciled
   *     CONFIRMED (STEP 61A's same-key interim rule) is NEVER announced
   *     as a fresh event, because it already existed before this
   *     Experience instance observed it (Event != State, STEP 71 S10/S16)
   *     - it remains available purely as snapshot state;
   *   - NEVER emits SESSION_STARTED - reload is not Session Start
   *     (STEP 71 S9/S15), and Runtime's own hydrate() sets sessionState
   *     directly (deriveInitialSessionState), never through the live
   *     FIRST_CART_ITEM_ADDED transition addItem() uses - there is no
   *     live transition here to observe in the first place.
   */
  async function hydrate(ownerUid, expiryOptions) {
    try {
      await runtime.hydrate(ownerUid, expiryOptions);
    } catch (_error) {
      return { snapshot: currentSnapshot() };
    }

    const snapshot = currentSnapshot();

    if (snapshot.degraded) {
      const anomalyEvent = createAnomalyDetectedEvent(snapshot.degraded);
      if (anomalyEvent) eventBus.emit(anomalyEvent);
    }

    if (snapshot.order.status === OrderStatus.UNCERTAIN) {
      const event = createOrderOutcomeChangedEvent(snapshot.order);
      if (event) eventBus.emit(event);
    }
    // Always record what's now known, event or not (STEP 72 S20) - this
    // is what correctly prevents, e.g., a reconciled CONFIRMED baseline
    // from later being mistaken for a fresh transition by some
    // subsequent, unrelated observeOrderOutcome() call.
    lastEmittedOrderStatus = snapshot.order.status;

    return { snapshot };
  }

  /**
   * Ends the Customer Session. Emits SESSION_ENDED if and only if
   * Runtime's own requestSessionEnd() resolves with
   * outcome === "SESSION_ENDED" - never for BLOCKED/RESET_INCOMPLETE,
   * never inferred any other way. This is structurally safe by
   * construction: requestSessionEnd()'s own ambiguity guard (LOCKED,
   * unmodified) already refuses to reach SESSION_ENDED while the
   * submission outcome is ambiguous, so this module needs no additional
   * check of its own (STEP 71 S18).
   *
   * `eventType` is passed through to Runtime verbatim, untouched and
   * uninterpreted - this module does not need to know Session's own
   * event-type vocabulary to do its job, keeping its dependency graph at
   * zero requires of kiosk/session.
   */
  async function endSession(eventType) {
    let result;
    try {
      result = await runtime.requestSessionEnd(eventType);
    } catch (_error) {
      return { outcome: "ORCHESTRATION_ERROR" };
    }

    if (result && result.outcome === "SESSION_ENDED") {
      eventBus.emit(createSessionEndedEvent());
      // Runtime itself clears submission/authoritativeResult to null on
      // a genuine SESSION_ENDED - the memo is reset to match, so the
      // NEXT session's first genuine outcome is never suppressed by a
      // stale leftover value from the session that just ended.
      lastEmittedOrderStatus = OrderStatus.NONE;
    }

    return { outcome: result && result.outcome };
  }

  function getSnapshot() {
    return currentSnapshot();
  }

  function subscribe(listener) {
    return eventBus.subscribe(listener);
  }

  return Object.freeze({
    hydrate,
    addItem,
    incrementLine,
    decrementLine,
    removeLine,
    setLineModifiers,
    setCustomerName,
    setNotes,
    clearCart,
    submit,
    retryUnknown,
    endSession,
    getSnapshot,
    subscribe,
  });
}

module.exports = { createExperienceOrchestrator };
