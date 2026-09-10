"use strict";

/**
 * Kiosk Experience contract - shapes and constants only. No I/O, no
 * Firebase, no Firestore, no IndexedDB, no OrderIntent, no Cart/
 * Submission/Session/Runtime import of any kind. Deliberately
 * self-contained, mirroring the isolation pattern every other kiosk/*
 * *Types.js file already uses.
 *
 * These vocabularies are the customer-safe semantic layer STEP 65-68
 * discovered and approved - they are intentionally NOT the same string
 * values as the Runtime/Session/Submission internal enums, so that
 * Experience code can never be mistaken for depending on (or accidentally
 * matching) an internal Runtime implementation detail. See
 * experienceProjection.js for the translation itself.
 */

// Deliberately lowercase and distinct from SessionStates' own uppercase
// values (IDLE/ACTIVE/AWAITING_OUTCOME/CONFIRMATION) - same meaning, a
// visibly different, independently-owned vocabulary.
const SessionPhase = Object.freeze({
  IDLE: "idle",
  ACTIVE: "active",
  AWAITING_OUTCOME: "awaiting_outcome",
  CONFIRMATION: "confirmation",
});

// The approved semantic order vocabulary (STEP 67/68 - LOCKED shape).
// DECLINED is reachable only via projectOrderOutcomeFromActionResult
// (see experienceProjection.js) - Runtime clears a rejected attempt to
// null immediately, so a DECLINED order is never observable from an
// ordinary snapshot read, only from the transient action result.
// Deliberately does NOT include PAID/FULFILLED/COMPLETED - those belong
// to future, separate Payment/Fulfillment domains (STEP 65 S14, STEP 68
// S18), never collapsed into this vocabulary.
const OrderStatus = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  UNCERTAIN: "UNCERTAIN",
  CONFIRMED: "CONFIRMED",
  DECLINED: "DECLINED",
});

// Customer-safe semantic rejection categories (STEP 66/67/68), mapped
// from the actual backend-derived raw codes documented in
// kiosk/orderIntent/orderIntentTypes.js. GENERAL_REJECTION is the
// deliberate safe fallback for any code not explicitly mapped below,
// including UNSPECIFIED_BUSINESS_REJECTION and any future/unrecognized
// backend code - additive backend vocabulary changes must never surface
// as an unmapped/undefined category here.
const RejectionCategory = Object.freeze({
  ITEM_UNAVAILABLE: "ITEM_UNAVAILABLE",
  MODIFIER_UNAVAILABLE: "MODIFIER_UNAVAILABLE",
  SELECTION_INCOMPLETE: "SELECTION_INCOMPLETE",
  QUANTITY_UNAVAILABLE: "QUANTITY_UNAVAILABLE",
  DUPLICATE_OR_CONFLICT: "DUPLICATE_OR_CONFLICT",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  REQUEST_INVALID: "REQUEST_INVALID",
  GENERAL_REJECTION: "GENERAL_REJECTION",
});

// Minimal, generic, customer-safe degraded/anomaly signal. Exact
// customer-facing wording remains DEFERRED (STEP 66/67/68) - this is
// only the shape: a small closed category, never a raw record.
const DegradedCategory = Object.freeze({
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
});

module.exports = {
  SessionPhase,
  OrderStatus,
  RejectionCategory,
  DegradedCategory,
};
