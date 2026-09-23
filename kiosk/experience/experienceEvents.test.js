"use strict";

/**
 * Kiosk Experience event creation tests (STEP 70).
 *
 * Run with: node --test kiosk/experience/experienceEvents.test.js
 * No new dependencies - Node's built-in test runner only. No Firebase,
 * no network, no DOM, no real Runtime - every input is a plain object
 * shaped like experienceProjection.js's own output.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  EventTypes,
  createSessionStartedEvent,
  createSubmissionStartedEvent,
  createOrderOutcomeChangedEvent,
  createAnomalyDetectedEvent,
  createSessionEndedEvent,
} = require("./experienceEvents");
const { OrderStatus, RejectionCategory, DegradedCategory } = require("./experienceTypes");

function authoritativeResultFixture(overrides) {
  return Object.assign(
    {
      orderState: "VALIDATED",
      authoritativeTotal: 30000,
      items: [
        {
          productId: "p1",
          productName: "Kopi Susu",
          quantity: 2,
          unitPrice: 15000,
          lineTotal: 30000,
          selectedModifiers: [{ groupName: "Size", optionName: "Large", price: 0 }],
        },
      ],
      customerName: "Budi",
      notes: null,
    },
    overrides
  );
}

function collectAllKeysDeep(value, into) {
  const keys = into || [];
  if (Array.isArray(value)) {
    for (const item of value) collectAllKeysDeep(item, keys);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      keys.push(key);
      collectAllKeysDeep(value[key], keys);
    }
  }
  return keys;
}

function collectAllStringValuesDeep(value, into) {
  const values = into || [];
  if (Array.isArray(value)) {
    for (const item of value) collectAllStringValuesDeep(item, values);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) collectAllStringValuesDeep(value[key], values);
  } else if (typeof value === "string") {
    values.push(value);
  }
  return values;
}

const FORBIDDEN_KEYS = [
  "ownerUid",
  "idempotencyKey",
  "committedAt",
  "rejectionReason",
  "unknownReason",
  "err",
  "error",
  "detail",
  "foundSchemaVersion",
  "avgCost",
  "hpp",
  "HPP",
  "recipe",
  "stock",
  "reservation",
  "persistence",
];

const FORBIDDEN_STRING_VALUES = [
  "uid-secret-owner-A",
  "sub_fixture_0000001",
  "PRODUCT_UNAVAILABLE",
  "MODIFIER_GROUP_UNAVAILABLE",
  "MODIFIER_OPTION_UNAVAILABLE",
  "REQUIRED_MODIFIER_MISSING",
  "INSUFFICIENT_STOCK",
  "IDEMPOTENCY_KEY_CONFLICT",
  "UNSPECIFIED_BUSINESS_REJECTION",
  "INVALID_REQUEST_SHAPE",
  "invalid-argument",
  "unauthenticated",
  "failed-precondition",
  "internal",
];

function assertNoForbiddenKeys(value, label) {
  const keys = collectAllKeysDeep(value);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.includes(forbidden), false, `${label}: must not contain key "${forbidden}"`);
  }
}

function assertNoForbiddenStringValues(value, label) {
  const values = collectAllStringValuesDeep(value);
  for (const forbidden of FORBIDDEN_STRING_VALUES) {
    assert.equal(values.includes(forbidden), false, `${label}: must not contain raw value "${forbidden}"`);
  }
}

// ============================================================
// A/B. Event type validity + exact five-event vocabulary
// ============================================================

test("A1. every EventTypes value is a non-empty string", () => {
  for (const value of Object.values(EventTypes)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
  }
});

test("B1. the vocabulary is exactly the five approved events, no synonyms/duplicates", () => {
  assert.deepEqual(Object.values(EventTypes).sort(), [
    "ANOMALY_DETECTED",
    "ORDER_OUTCOME_CHANGED",
    "SESSION_ENDED",
    "SESSION_STARTED",
    "SUBMISSION_STARTED",
  ]);
  // explicitly confirm none of the rejected synonym candidates exist
  const forbiddenSynonyms = [
    "SESSION_BEGIN",
    "ORDER_SUBMITTED",
    "ORDER_SUCCESS",
    "ORDER_FAILED",
    "PAYMENT_SUCCESS",
    "SESSION_COMPLETE",
    "CART_CHANGED",
    "CART_UPDATED",
  ];
  for (const synonym of forbiddenSynonyms) {
    assert.equal(EventTypes[synonym], undefined, "must not define synonym " + synonym);
  }
});

// ============================================================
// C/D/E/J. Payload shape for the no-payload events
// ============================================================

test("C1/D1. SESSION_STARTED has type + empty payload", () => {
  const event = createSessionStartedEvent();
  assert.equal(event.type, EventTypes.SESSION_STARTED);
  assert.deepEqual(event.payload, {});
});

test("C2/E1. SUBMISSION_STARTED has type + empty payload", () => {
  const event = createSubmissionStartedEvent();
  assert.equal(event.type, EventTypes.SUBMISSION_STARTED);
  assert.deepEqual(event.payload, {});
});

test("C3/J1. SESSION_ENDED has type + empty payload", () => {
  const event = createSessionEndedEvent();
  assert.equal(event.type, EventTypes.SESSION_ENDED);
  assert.deepEqual(event.payload, {});
});

// ============================================================
// F/Y. ORDER_OUTCOME_CHANGED / UNCERTAIN
// ============================================================

test("F1/Y1. UNCERTAIN payload contains ONLY status - no result, no rejectionCategory key at all", () => {
  const event = createOrderOutcomeChangedEvent({ status: OrderStatus.UNCERTAIN, result: null, rejectionCategory: null });
  assert.equal(event.type, EventTypes.ORDER_OUTCOME_CHANGED);
  assert.deepEqual(Object.keys(event.payload), ["status"]);
  assert.equal(event.payload.status, OrderStatus.UNCERTAIN);
});

// ============================================================
// G. ORDER_OUTCOME_CHANGED / CONFIRMED
// ============================================================

test("G1. CONFIRMED payload carries the customer-safe result, field-whitelisted", () => {
  const event = createOrderOutcomeChangedEvent({
    status: OrderStatus.CONFIRMED,
    result: authoritativeResultFixture(),
    rejectionCategory: null,
  });
  assert.deepEqual(Object.keys(event.payload).sort(), ["result", "status"]);
  assert.equal(event.payload.result.authoritativeTotal, 30000);
  assert.equal(event.payload.result.items[0].productName, "Kopi Susu");
});

test("G2. W1. CONFIRMED result is whitelisted through experienceProjection's own reconstruction, not trusted verbatim", () => {
  const taintedResult = authoritativeResultFixture({
    // simulate a maliciously/accidentally over-populated result
    items: [
      {
        productId: "p1",
        productName: "Kopi Susu",
        quantity: 2,
        unitPrice: 15000,
        lineTotal: 30000,
        selectedModifiers: [{ groupName: "Size", optionName: "Large", price: 0 }],
        avgCost: 4000,
        hpp: 4200,
      },
    ],
  });
  taintedResult.ownerUid = "uid-secret-owner-A";
  taintedResult.idempotencyKey = "sub_fixture_0000001";

  const event = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: taintedResult, rejectionCategory: null });
  assertNoForbiddenKeys(event, "G2 tainted-input event");
  assertNoForbiddenStringValues(event, "G2 tainted-input event");
  assert.deepEqual(Object.keys(event.payload.result.items[0]).sort(), [
    "lineTotal",
    "productId",
    "productName",
    "quantity",
    "selectedModifiers",
    "unitPrice",
  ]);
});

// ============================================================
// H/X. ORDER_OUTCOME_CHANGED / DECLINED
// ============================================================

test("H1. DECLINED payload carries only status + semantic rejectionCategory", () => {
  const event = createOrderOutcomeChangedEvent({
    status: OrderStatus.DECLINED,
    result: null,
    rejectionCategory: RejectionCategory.QUANTITY_UNAVAILABLE,
  });
  assert.deepEqual(Object.keys(event.payload).sort(), ["rejectionCategory", "status"]);
  assert.equal(event.payload.rejectionCategory, RejectionCategory.QUANTITY_UNAVAILABLE);
});

test("X1/L1. a raw backend code passed as rejectionCategory is rejected by the enum whitelist, never surfaces", () => {
  const event = createOrderOutcomeChangedEvent({
    status: OrderStatus.DECLINED,
    result: null,
    rejectionCategory: "INSUFFICIENT_STOCK", // raw code, not a semantic category - must be filtered
  });
  assert.equal(Object.prototype.hasOwnProperty.call(event.payload, "rejectionCategory"), false);
  assertNoForbiddenStringValues(event, "X1 raw-code-rejected event");
});

test("X2. end-to-end: projectOrderOutcomeFromActionResult -> createOrderOutcomeChangedEvent for a REJECTED action result", () => {
  const { projectOrderOutcomeFromActionResult } = require("./experienceProjection");
  const projected = projectOrderOutcomeFromActionResult({
    outcome: "REJECTED",
    category: "VALIDATION_REJECTION",
    reason: "PRODUCT_UNAVAILABLE",
    attempt: null,
  });
  const event = createOrderOutcomeChangedEvent(projected);
  assert.equal(event.payload.status, OrderStatus.DECLINED);
  assert.equal(event.payload.rejectionCategory, RejectionCategory.ITEM_UNAVAILABLE);
  assertNoForbiddenStringValues(event, "X2 end-to-end declined event");
});

// ============================================================
// PENDING/NONE must not produce an event at all
// ============================================================

test("PENDING/NONE order status yields null - not a meaningful outcome-changed moment", () => {
  assert.equal(createOrderOutcomeChangedEvent({ status: OrderStatus.PENDING }), null);
  assert.equal(createOrderOutcomeChangedEvent({ status: OrderStatus.NONE }), null);
  assert.equal(createOrderOutcomeChangedEvent(null), null);
  assert.equal(createOrderOutcomeChangedEvent(undefined), null);
});

// ============================================================
// I. ANOMALY_DETECTED
// ============================================================

test("I1. ANOMALY_DETECTED carries only the closed category enum", () => {
  const event = createAnomalyDetectedEvent({ category: DegradedCategory.NEEDS_ATTENTION });
  assert.equal(event.type, EventTypes.ANOMALY_DETECTED);
  assert.deepEqual(event.payload, { category: DegradedCategory.NEEDS_ATTENTION });
});

test("M1. a raw record/error object passed as degraded input never survives - only the whitelisted category can", () => {
  const event = createAnomalyDetectedEvent({
    category: DegradedCategory.NEEDS_ATTENTION,
    rawSubmission: { ownerUid: "uid-secret-owner-A", idempotencyKey: "sub_fixture_0000001" },
    rawError: new Error("disk full"),
  });
  assert.deepEqual(Object.keys(event.payload), ["category"]);
  assertNoForbiddenKeys(event, "M1 anomaly event");
  assertNoForbiddenStringValues(event, "M1 anomaly event");
});

test("no anomaly -> createAnomalyDetectedEvent returns null", () => {
  assert.equal(createAnomalyDetectedEvent(null), null);
  assert.equal(createAnomalyDetectedEvent({ category: "SOMETHING_UNAPPROVED" }), null);
});

// ============================================================
// K/N. Forbidden identity fields, recursively, across every event
// ============================================================

test("K1/N1. no created event, of any type, ever contains identity/internal fields even when nested", () => {
  const events = [
    createSessionStartedEvent(),
    createSubmissionStartedEvent(),
    createOrderOutcomeChangedEvent({ status: OrderStatus.UNCERTAIN }),
    createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: authoritativeResultFixture() }),
    createOrderOutcomeChangedEvent({ status: OrderStatus.DECLINED, rejectionCategory: RejectionCategory.AUTH_REQUIRED }),
    createAnomalyDetectedEvent({ category: DegradedCategory.NEEDS_ATTENTION }),
    createSessionEndedEvent(),
  ];
  for (const event of events) {
    assertNoForbiddenKeys(event, "event " + (event && event.type));
    assertNoForbiddenStringValues(event, "event " + (event && event.type));
  }
});

// ============================================================
// O. Event immutability
// ============================================================

test("O1. mutating the original input after creation does not affect the created event", () => {
  const rawResult = authoritativeResultFixture();
  const event = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: rawResult });

  rawResult.authoritativeTotal = 999999;
  rawResult.items[0].productName = "Tampered";

  assert.equal(event.payload.result.authoritativeTotal, 30000);
  assert.equal(event.payload.result.items[0].productName, "Kopi Susu");
});

test("O2. created events are frozen and cannot be mutated in place", () => {
  const event = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: authoritativeResultFixture() });
  assert.throws(() => {
    "use strict";
    event.payload.status = "TAMPERED";
  }, TypeError);
  assert.throws(() => {
    "use strict";
    event.type = "TAMPERED";
  }, TypeError);
  assert.throws(() => {
    "use strict";
    event.payload.result.items.push({ hacked: true });
  }, TypeError);
});

// ============================================================
// V. No second-state-machine / dependency boundary
// ============================================================

test("V1/U1. experienceEvents.js requires only experienceProjection.js and experienceTypes.js - nothing else", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceEvents.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets.sort(), ["./experienceProjection", "./experienceTypes"]);
});

test("U2. no actual Firebase/network/timer/DOM API usage in experienceEvents.js", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceEvents.js"), "utf8");
  for (const forbiddenUsage of ["require(\"firebase", "indexedDB.", "httpsCallable(", "fetch(", "setTimeout(", "setInterval(", "document.", "window."]) {
    assert.equal(source.includes(forbiddenUsage), false, "must not actually use " + forbiddenUsage);
  }
});

// ============================================================
// Z. Deterministic event creation
// ============================================================

test("Z1. equivalent but distinct inputs produce deep-equal created events", () => {
  const e1 = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: authoritativeResultFixture() });
  const e2 = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: authoritativeResultFixture() });
  assert.deepEqual(e1, e2);
});
