"use strict";

/**
 * Kiosk Experience semantic event vocabulary + pure event-creation
 * helpers (STEP 70). No I/O, no Firebase, no Firestore, no IndexedDB,
 * no network, no timers, no DOM, and no requires of kiosk/cart,
 * kiosk/persistence, kiosk/submission, kiosk/orderIntent, kiosk/session,
 * or kiosk/runtime - the only require is experienceProjection.js/
 * experienceTypes.js, STEP 69's own already-proven-safe translation
 * layer.
 *
 * LOCKED vocabulary (STEP 68/70) - exactly these five, no synonyms:
 *   SESSION_STARTED, SUBMISSION_STARTED, ORDER_OUTCOME_CHANGED,
 *   ANOMALY_DETECTED, SESSION_ENDED.
 *
 * Event != State (STEP 67/68/70): an event is a meaningful TIMING
 * signal ("something just happened"), never the sole source of truth.
 * A consumer that starts listening after an event fired must still be
 * able to obtain current truth from ExperienceSnapshot
 * (experienceProjection.js) - nothing here replays history or replaces
 * the snapshot.
 *
 * This module creates plain, frozen {type, payload} event objects. It
 * does not deliver them - see experienceEventBus.js for that. It holds
 * no listener state, no subscription, no operational/business logic:
 * every create*Event() function is a pure, deterministic sanitizer that
 * either returns a safe frozen event or null (when given a status that
 * isn't a meaningful "changed" moment for that event type - the caller
 * must not emit in that case).
 */

const { projectAuthoritativeResult } = require("./experienceProjection");
const { OrderStatus, RejectionCategory, DegradedCategory } = require("./experienceTypes");

const EventTypes = Object.freeze({
  SESSION_STARTED: "SESSION_STARTED",
  SUBMISSION_STARTED: "SUBMISSION_STARTED",
  ORDER_OUTCOME_CHANGED: "ORDER_OUTCOME_CHANGED",
  ANOMALY_DETECTED: "ANOMALY_DETECTED",
  SESSION_ENDED: "SESSION_ENDED",
});

function localDeepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(localDeepFreeze));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = localDeepFreeze(value[key]);
    }
    return Object.freeze(out);
  }
  return value;
}

const EMPTY_PAYLOAD = Object.freeze({});

/** No payload: marks the moment Session transitions IDLE -> ACTIVE. */
function createSessionStartedEvent() {
  return Object.freeze({ type: EventTypes.SESSION_STARTED, payload: EMPTY_PAYLOAD });
}

/** No payload: marks the moment a submission attempt explicitly begins. */
function createSubmissionStartedEvent() {
  return Object.freeze({ type: EventTypes.SUBMISSION_STARTED, payload: EMPTY_PAYLOAD });
}

/**
 * Builds an ORDER_OUTCOME_CHANGED event from an already-projected order
 * value - i.e. the {status, result, rejectionCategory} shape produced by
 * experienceProjection.js's own projectOrderFromSnapshot (internal) or
 * exported projectOrderOutcomeFromActionResult. This function does NOT
 * re-derive semantic meaning from raw Runtime/backend data - that rule
 * already lives in experienceProjection.js and is reused, not duplicated
 * (STEP 70 S13).
 *
 * Returns null for NONE/PENDING - those are not "outcome changed" events
 * (PENDING is exactly what SUBMISSION_STARTED already marks; NONE means
 * nothing meaningful happened). The caller must not emit in that case.
 *
 * Defensive whitelisting (not a second semantic implementation): the
 * `result` payload is re-passed through experienceProjection.js's own
 * projectAuthoritativeResult (idempotent on an already-safe value) and
 * `rejectionCategory` is checked against the closed RejectionCategory
 * enum - so even a malformed/untrusted input can never leak an
 * unexpected field through this boundary.
 */
function createOrderOutcomeChangedEvent(projectedOrder) {
  const safe = projectedOrder || {};
  const meaningfulStatuses = [OrderStatus.UNCERTAIN, OrderStatus.CONFIRMED, OrderStatus.DECLINED];
  if (!meaningfulStatuses.includes(safe.status)) {
    return null;
  }

  const payload = { status: safe.status };
  if (safe.status === OrderStatus.CONFIRMED && safe.result) {
    payload.result = projectAuthoritativeResult(safe.result);
  }
  if (safe.status === OrderStatus.DECLINED && Object.values(RejectionCategory).includes(safe.rejectionCategory)) {
    payload.rejectionCategory = safe.rejectionCategory;
  }

  return Object.freeze({ type: EventTypes.ORDER_OUTCOME_CHANGED, payload: localDeepFreeze(payload) });
}

/**
 * Builds an ANOMALY_DETECTED event from an already-projected degraded
 * value (experienceProjection.js's own projectDegraded output shape:
 * null | {category}). Returns null when there is nothing to report -
 * the caller must not emit in that case.
 */
function createAnomalyDetectedEvent(projectedDegraded) {
  const safe = projectedDegraded || {};
  if (!Object.values(DegradedCategory).includes(safe.category)) {
    return null;
  }
  return Object.freeze({ type: EventTypes.ANOMALY_DETECTED, payload: Object.freeze({ category: safe.category }) });
}

/** No payload: marks the moment requestSessionEnd() resolves to SESSION_ENDED. */
function createSessionEndedEvent() {
  return Object.freeze({ type: EventTypes.SESSION_ENDED, payload: EMPTY_PAYLOAD });
}

module.exports = {
  EventTypes,
  createSessionStartedEvent,
  createSubmissionStartedEvent,
  createOrderOutcomeChangedEvent,
  createAnomalyDetectedEvent,
  createSessionEndedEvent,
};
