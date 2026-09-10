"use strict";

/**
 * Kiosk Experience projection - the customer-safe boundary between the
 * LOCKED Kiosk Runtime (STEP 54-62) and a future Experience/Aul layer
 * (STEP 65-68 discovery, approved for implementation at STEP 68).
 *
 * This module is a PURE TRANSLATION BOUNDARY, not an operational
 * controller: it holds no state of its own, requires NOTHING from
 * kiosk/cart, kiosk/persistence, kiosk/submission, kiosk/orderIntent,
 * kiosk/session, or kiosk/runtime, has no Firebase/Firestore/IndexedDB/
 * network/timer/DOM/AWR/payment dependency, and never decides an order
 * outcome, session transition, or idempotency question itself - every
 * function here only reformats plain data Runtime already produced.
 *
 * Two distinct inputs, because Runtime's own actual contract (STEP 62)
 * makes this necessary, not by choice:
 *
 *   projectExperienceSnapshot(runtimeSnapshot) - takes the ONGOING shape
 *     Runtime's getSnapshot() returns: {cart, submission, session,
 *     authoritativeResult, hydrated}. This alone can express NONE,
 *     PENDING, UNCERTAIN, and CONFIRMED - but never DECLINED, because
 *     Runtime clears a rejected attempt to null (via
 *     applyRejectedOrCannotBeginOutcome) before/at the same moment it
 *     reaches that outcome, so no trace of a rejection ever survives
 *     into a later getSnapshot() read.
 *
 *   projectOrderOutcomeFromActionResult(actionResult) - takes the
 *     TRANSIENT {outcome, attempt, category, reason} object Runtime's
 *     own submit()/retryUnknown() return directly. This is the only
 *     place DECLINED can be produced, and the only place a semantic
 *     rejection category is available at all, since the raw
 *     rejectionReason never survives into the ongoing snapshot either.
 *
 * Neither function is an event bus (STEP 69 explicitly excludes that);
 * both are plain, synchronous, deterministic functions a future event
 * layer can call, not a replacement for one.
 */

const {
  SessionPhase,
  OrderStatus,
  RejectionCategory,
  DegradedCategory,
} = require("./experienceTypes");

/**
 * Self-contained deep clone + freeze, deliberately NOT imported from
 * kiosk/submission/submissionTypes.js's own deepFreezeClone - this
 * module holds zero requires of any other kiosk/* module (STEP 69 S16),
 * mirroring the same per-module self-containment convention already
 * used throughout kiosk/ (e.g. the IDEMPOTENCY_KEY_PATTERN literal is
 * independently duplicated in three separate *Types.js files rather
 * than shared). Guarantees the returned ExperienceSnapshot never shares
 * a mutable array/object reference with whatever Runtime state it was
 * built from.
 */
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

function projectSessionPhase(rawSession) {
  switch (rawSession) {
    case "IDLE":
      return SessionPhase.IDLE;
    case "ACTIVE":
      return SessionPhase.ACTIVE;
    case "AWAITING_OUTCOME":
      return SessionPhase.AWAITING_OUTCOME;
    case "CONFIRMATION":
      return SessionPhase.CONFIRMATION;
    default:
      // Defensive only - every real SessionStates value is handled above;
      // an unrecognized value must never throw or fabricate a phase.
      return SessionPhase.IDLE;
  }
}

function projectSelectedModifiers(rawModifiers) {
  if (!Array.isArray(rawModifiers)) return [];
  return rawModifiers.map((m) => ({
    groupId: m.groupId,
    optionId: m.optionId,
  }));
}

function projectCartLine(rawLine) {
  const safeLine = rawLine || {};
  const displaySnapshot = safeLine.displaySnapshot || {};
  return {
    lineRef: safeLine.localLineId,
    productId: safeLine.productId,
    quantity: safeLine.quantity,
    selectedModifiers: projectSelectedModifiers(safeLine.selectedModifiers),
    // Explicitly non-authoritative, customer's own cached echo - never
    // the final price. displaySnapshot fields beyond name/price
    // (imageUrl, categoryLabel) are intentionally not projected yet -
    // kept minimal per STEP 69 S21; see final report "limitations".
    displayName: typeof displaySnapshot.name === "string" ? displaySnapshot.name : null,
    displayPrice: typeof displaySnapshot.price === "number" ? displaySnapshot.price : null,
  };
}

function projectCart(rawCart) {
  const safeCart = rawCart || { lines: [], customerName: null, notes: null };
  return {
    lines: Array.isArray(safeCart.lines) ? safeCart.lines.map(projectCartLine) : [],
    customerName: safeCart.customerName === undefined ? null : safeCart.customerName,
    notes: safeCart.notes === undefined ? null : safeCart.notes,
  };
}

/**
 * Reconstructs ONLY the known-safe authoritativeResult fields explicitly,
 * field by field, rather than passing the raw object through - so that
 * even if a future Runtime/backend change ever added an unexpected extra
 * field to the real authoritativeResult, it could not silently cross
 * this boundary un-reviewed.
 */
function projectAuthoritativeResult(rawResult) {
  if (!rawResult) return null;
  return {
    orderState: rawResult.orderState,
    authoritativeTotal: rawResult.authoritativeTotal,
    items: Array.isArray(rawResult.items)
      ? rawResult.items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          selectedModifiers: Array.isArray(item.selectedModifiers)
            ? item.selectedModifiers.map((m) => ({
                groupName: m.groupName,
                optionName: m.optionName,
                price: m.price,
              }))
            : [],
        }))
      : [],
    customerName: rawResult.customerName === undefined ? null : rawResult.customerName,
    notes: rawResult.notes === undefined ? null : rawResult.notes,
  };
}

/**
 * Maps an actual raw backend-derived reason code (as produced by
 * kiosk/orderIntent/orderIntentTypes.js's classifyCallableError, and
 * carried verbatim into a SubmissionAttempt's rejectionReason /
 * an outcome's own `reason`) to the small, stable, customer-safe
 * semantic vocabulary. Any code not explicitly listed - including
 * UNSPECIFIED_BUSINESS_REJECTION and any future/unrecognized backend
 * code - safely falls back to GENERAL_REJECTION rather than ever
 * surfacing the raw string or leaving the category undefined.
 */
function mapRejectionReason(rawReason) {
  switch (rawReason) {
    case "PRODUCT_UNAVAILABLE":
      return RejectionCategory.ITEM_UNAVAILABLE;
    case "MODIFIER_GROUP_UNAVAILABLE":
    case "MODIFIER_OPTION_UNAVAILABLE":
      return RejectionCategory.MODIFIER_UNAVAILABLE;
    case "REQUIRED_MODIFIER_MISSING":
      return RejectionCategory.SELECTION_INCOMPLETE;
    case "INSUFFICIENT_STOCK":
      return RejectionCategory.QUANTITY_UNAVAILABLE;
    case "IDEMPOTENCY_KEY_CONFLICT":
      return RejectionCategory.DUPLICATE_OR_CONFLICT;
    case "AUTH_REQUIRED":
      return RejectionCategory.AUTH_REQUIRED;
    case "INVALID_REQUEST_SHAPE":
      return RejectionCategory.REQUEST_INVALID;
    default:
      return RejectionCategory.GENERAL_REJECTION;
  }
}

/**
 * Derives the ORDER domain from Runtime's ONGOING snapshot shape only
 * (submission + authoritativeResult). Cannot produce DECLINED - see
 * module header. rejectionCategory is always null here.
 */
function projectOrderFromSnapshot(rawSubmission, rawAuthoritativeResult) {
  const hasSubmission = !!rawSubmission;
  const hasResult = !!rawAuthoritativeResult;

  if (hasSubmission && hasResult) {
    // Anomalous coexistence (STEP 61A/65/66/69): under every correct-
    // operation path Runtime clears one before/when setting the other;
    // this combination is reachable ONLY via hydrate()'s own mismatch
    // path, which always translates a hydrated IN_FLIGHT to UNKNOWN
    // first - so rawSubmission.status here is always "UNKNOWN". ORDER
    // must not guess CONFIRMED merely because a result exists; the
    // conservative, evidence-consistent status is UNCERTAIN, identical
    // to how a live UNKNOWN would read. DEGRADED (see projectDegraded)
    // is the separate signal that something additionally needs
    // attention - ORDER itself stays within its own honest vocabulary.
    return { status: OrderStatus.UNCERTAIN, result: null, rejectionCategory: null };
  }
  if (hasResult) {
    return { status: OrderStatus.CONFIRMED, result: projectAuthoritativeResult(rawAuthoritativeResult), rejectionCategory: null };
  }
  if (hasSubmission) {
    if (rawSubmission.status === "IN_FLIGHT") {
      return { status: OrderStatus.PENDING, result: null, rejectionCategory: null };
    }
    if (rawSubmission.status === "UNKNOWN") {
      return { status: OrderStatus.UNCERTAIN, result: null, rejectionCategory: null };
    }
    // SUCCEEDED/REJECTED should never be observable here under current
    // Runtime behavior (both are cleared to null at/before the moment
    // they occur) - defensive fallback only, never fabricates CONFIRMED.
    return { status: OrderStatus.NONE, result: null, rejectionCategory: null };
  }
  return { status: OrderStatus.NONE, result: null, rejectionCategory: null };
}

/**
 * Derives the ORDER domain from the TRANSIENT result object Runtime's
 * own submit()/retryUnknown() return directly. This is the only source
 * for DECLINED and for a semantic rejectionCategory, since Runtime
 * never persists a rejection's raw reason into its ongoing snapshot.
 */
function projectOrderOutcomeFromActionResult(actionResult) {
  const safeResult = actionResult || {};

  if (safeResult.outcome === "SUCCEEDED") {
    const rawResult = safeResult.attempt && safeResult.attempt.authoritativeResult;
    return { status: OrderStatus.CONFIRMED, result: projectAuthoritativeResult(rawResult), rejectionCategory: null };
  }
  if (safeResult.outcome === "REJECTED") {
    return { status: OrderStatus.DECLINED, result: null, rejectionCategory: mapRejectionReason(safeResult.reason) };
  }
  if (safeResult.outcome === "UNKNOWN") {
    return { status: OrderStatus.UNCERTAIN, result: null, rejectionCategory: null };
  }
  if (safeResult.outcome === "BLOCKED") {
    // BLOCKED never represents a resolved order. If a genuine attempt
    // still exists in memory (write-ahead persisted but not yet called,
    // or a hydrated-but-unverified one), reflect its real unresolved
    // status; otherwise (e.g. CANNOT_BEGIN on an empty cart) nothing was
    // ever created, and NONE is the honest answer.
    const attemptStatus = safeResult.attempt && safeResult.attempt.status;
    if (attemptStatus === "IN_FLIGHT") return { status: OrderStatus.PENDING, result: null, rejectionCategory: null };
    if (attemptStatus === "UNKNOWN") return { status: OrderStatus.UNCERTAIN, result: null, rejectionCategory: null };
    return { status: OrderStatus.NONE, result: null, rejectionCategory: null };
  }
  return { status: OrderStatus.NONE, result: null, rejectionCategory: null };
}

/**
 * Minimal, generic degraded/anomaly signal. Derived purely from the same
 * ongoing-snapshot coexistence fact projectOrderFromSnapshot already
 * relies on - never carries the raw submission/result records,
 * idempotencyKey, ownerUid, or any diagnostic detail.
 */
function projectDegraded(rawSubmission, rawAuthoritativeResult) {
  if (rawSubmission && rawAuthoritativeResult) {
    return { category: DegradedCategory.NEEDS_ATTENTION };
  }
  return null;
}

/**
 * Derived, customer-facing capability convenience signals (STEP 68 S6,
 * S9 - LOCKED as "convenience only, never authority"). Each mirrors the
 * SAME guard Runtime's own action method already enforces - Runtime
 * re-validates independently at call time regardless of what these
 * flags say, so a stale or wrong flag here can never cause an unsafe
 * action to actually execute.
 *
 * canRequestSessionEnd mirrors ONLY sessionMachine.js's ambiguity guard
 * (submission must not be IN_FLIGHT/UNKNOWN) - it deliberately does NOT
 * capture the additional per-event-type eligibility check
 * (eligibleStatesFor: CUSTOMER_CANCELLED requires ACTIVE, the
 * disengagement events require CONFIRMATION). Runtime's
 * requestSessionEnd() remains the sole authority for both checks.
 */
function deriveCapabilities(rawCart, rawSubmission) {
  const cartHasLines = !!(rawCart && Array.isArray(rawCart.lines) && rawCart.lines.length > 0);
  const submissionIsNull = rawSubmission === null || rawSubmission === undefined;
  const submissionIsUnknown = !!rawSubmission && rawSubmission.status === "UNKNOWN";
  const submissionIsAmbiguous = !!rawSubmission && (rawSubmission.status === "IN_FLIGHT" || rawSubmission.status === "UNKNOWN");

  return {
    canSubmit: submissionIsNull && cartHasLines,
    canRetryUnknown: submissionIsUnknown,
    canRequestSessionEnd: !submissionIsAmbiguous,
  };
}

/**
 * The main projection. Pure function: explicit input, explicit output,
 * no I/O, no side effects, no shared mutable references with its input.
 *
 * @param {Object} runtimeSnapshot - the exact shape kiosk/runtime's own
 *   getSnapshot() returns: {cart, submission, session, authoritativeResult, hydrated}.
 * @returns {Object} a frozen, deep-cloned ExperienceSnapshot:
 *   {ready, session, cart, order, degraded, capabilities}
 */
function projectExperienceSnapshot(runtimeSnapshot) {
  const safeSnapshot = runtimeSnapshot || {};
  const rawSubmission = safeSnapshot.submission || null;
  const rawAuthoritativeResult = safeSnapshot.authoritativeResult || null;

  const snapshot = {
    ready: !!safeSnapshot.hydrated,
    session: projectSessionPhase(safeSnapshot.session),
    cart: projectCart(safeSnapshot.cart),
    order: projectOrderFromSnapshot(rawSubmission, rawAuthoritativeResult),
    degraded: projectDegraded(rawSubmission, rawAuthoritativeResult),
    capabilities: deriveCapabilities(safeSnapshot.cart, rawSubmission),
  };

  return localDeepFreeze(snapshot);
}

module.exports = {
  projectExperienceSnapshot,
  projectOrderOutcomeFromActionResult,
  mapRejectionReason,
  // Additive STEP 70 export: reused as-is (zero behavior change) by
  // experienceEvents.js so ORDER_OUTCOME_CHANGED's CONFIRMED payload is
  // whitelisted through the SAME already-proven-safe field reconstruction,
  // rather than a second, duplicated implementation of the same rule.
  projectAuthoritativeResult,
};
