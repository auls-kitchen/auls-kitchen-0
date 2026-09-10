"use strict";

/**
 * Kiosk Experience Orchestrator tests (STEP 72).
 *
 * Run with: node --test kiosk/experience/experienceOrchestrator.test.js
 * No new dependencies - Node's built-in test runner only. Unlike the
 * orchestrator's OWN source (which requires nothing from kiosk/runtime),
 * this TEST FILE deliberately uses the REAL kiosk/runtime/kioskRuntime.js
 * + REAL kiosk/persistence/persistenceAdapter.js (over a plain in-memory
 * store) + REAL kiosk/experience/experienceEventBus.js, mirroring the
 * same integration-realism precedent kioskRuntime.test.js itself already
 * established - this is the only way to prove the orchestrator correctly
 * wraps actual Runtime behavior, not a hand-waved mock of it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createExperienceOrchestrator } = require("./experienceOrchestrator");
const { createEventBus } = require("./experienceEventBus");
const { EventTypes: ExperienceEventTypes, createOrderOutcomeChangedEvent } = require("./experienceEvents");
const { OrderStatus, RejectionCategory } = require("./experienceTypes");
const { createKioskRuntime } = require("../runtime/kioskRuntime");
const { createPersistenceAdapter } = require("../persistence/persistenceAdapter");

// --- fixtures ---

function createInMemoryStore() {
  let value;
  let hasValue = false;
  return {
    async get() {
      return hasValue ? value : undefined;
    },
    async set(key, val) {
      value = val;
      hasValue = true;
    },
    async delete() {
      hasValue = false;
      value = undefined;
    },
  };
}

function createSpyCallable(impl) {
  const calls = [];
  const fn = async (payload) => {
    calls.push(payload);
    return impl(payload);
  };
  fn.calls = calls;
  return fn;
}

function validBackendResult(overrides) {
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
      customerName: null,
      notes: null,
    },
    overrides
  );
}

function makeAttemptFixture(overrides) {
  return Object.assign(
    {
      idempotencyKey: "fixture-key-0001",
      items: [{ productId: "p1", quantity: 1, selectedModifiers: [] }],
      customerName: null,
      notes: null,
      status: "IN_FLIGHT",
    },
    overrides
  );
}

function makeResultFixture(overrides) {
  return Object.assign(
    {
      orderState: "VALIDATED",
      authoritativeTotal: 15000,
      items: [{ productId: "p1", productName: "Kopi", quantity: 1, unitPrice: 15000, lineTotal: 15000, selectedModifiers: [] }],
      customerName: null,
      notes: null,
    },
    overrides
  );
}

function makeCartDraftFixture(overrides) {
  return Object.assign(
    {
      lines: [{ localLineId: "line_1", productId: "p1", quantity: 2, selectedModifiers: [], displaySnapshot: {} }],
      customerName: null,
      notes: null,
    },
    overrides
  );
}

// Raw builder: constructs a real Runtime + real Persistence (in-memory
// store) + real event bus + the Orchestrator under test, WITHOUT
// hydrating - used only by tests that must seed persistence BEFORE
// calling hydrate() themselves.
function buildRawOrchestrator(callOrderIntent, extraRuntimeDeps) {
  const store = createInMemoryStore();
  const persistence = createPersistenceAdapter(store);
  const runtime = createKioskRuntime(Object.assign({ persistence, callOrderIntent }, extraRuntimeDeps));
  const eventBus = createEventBus();
  const orchestrator = createExperienceOrchestrator({ runtime, eventBus });
  return { orchestrator, runtime, persistence, eventBus };
}

// Convenience builder: same as above, but also hydrates against a fresh
// (empty) store under "uid-A" first, exactly like kioskRuntime.test.js's
// own established convention of always establishing ownerUid before
// exercising Cart/Submission actions.
async function buildOrchestrator(callOrderIntent, extraRuntimeDeps) {
  const built = buildRawOrchestrator(callOrderIntent, extraRuntimeDeps);
  await built.orchestrator.hydrate("uid-A");
  return built;
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
  "recipe",
  "stock",
  "reservation",
  "persistence",
  "callOrderIntent",
  "runtime",
  "eventBus",
];

const FORBIDDEN_STRING_VALUES = ["INSUFFICIENT_STOCK", "IDEMPOTENCY_KEY_CONFLICT", "invalid-argument", "unauthenticated", "internal"];

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

function subscribeCollector(eventBus) {
  const received = [];
  eventBus.subscribe((event) => received.push(event));
  return received;
}

// ============================================================
// A. Constructor / dependency injection
// ============================================================

test("A1. constructor requires both runtime and eventBus", () => {
  assert.throws(() => createExperienceOrchestrator({}), TypeError);
  assert.throws(() => createExperienceOrchestrator({ runtime: {} }), TypeError);
  assert.throws(() => createExperienceOrchestrator({ eventBus: {} }), TypeError);
  assert.throws(() => createExperienceOrchestrator(), TypeError);
});

test("A2. constructor succeeds with both dependencies and exposes exactly the documented methods", () => {
  const { orchestrator } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  assert.deepEqual(Object.keys(orchestrator).sort(), [
    "addItem",
    "clearCart",
    "decrementLine",
    "endSession",
    "getSnapshot",
    "hydrate",
    "incrementLine",
    "removeLine",
    "retryUnknown",
    "setCustomerName",
    "setLineModifiers",
    "setNotes",
    "submit",
    "subscribe",
  ]);
});

// ============================================================
// B/T/17/AK. No global singleton / instance independence
// ============================================================

test("B1/AK1. two orchestrator instances are fully independent (state, events, dedup memo)", async () => {
  const a = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const b = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const receivedA = subscribeCollector(a.eventBus);
  const receivedB = subscribeCollector(b.eventBus);

  a.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 0);
});

// ============================================================
// C/15/AE. getSnapshot exposes ExperienceSnapshot only
// ============================================================

test("C1/15. getSnapshot() returns exactly the ExperienceSnapshot shape, no Runtime reference or internal fields", () => {
  const { orchestrator } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const snapshot = orchestrator.getSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["capabilities", "cart", "degraded", "order", "ready", "session"]);
  assertNoForbiddenKeys(snapshot, "getSnapshot()");
});

// ============================================================
// D-H. SESSION_STARTED trigger rules
// ============================================================

test("D1/1. SESSION_STARTED fires exactly once, on the real IDLE->ACTIVE transition from the first addItem", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const received = subscribeCollector(eventBus);

  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, ExperienceEventTypes.SESSION_STARTED);
});

test("E1. no SESSION_STARTED on incrementLine after the session is already active", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const cart = orchestrator.getSnapshot().cart;
  const received = subscribeCollector(eventBus); // subscribe only AFTER the initial add

  orchestrator.incrementLine(cart.lines[0].lineRef);

  assert.equal(received.length, 0);
});

test("F1. no SESSION_STARTED on decrementLine", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 2, selectedModifiers: [] });
  const cart = orchestrator.getSnapshot().cart;
  const received = subscribeCollector(eventBus);

  orchestrator.decrementLine(cart.lines[0].lineRef);

  assert.equal(received.length, 0);
});

test("G1. no SESSION_STARTED on removeLine", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const cart = orchestrator.getSnapshot().cart;
  const received = subscribeCollector(eventBus);

  orchestrator.removeLine(cart.lines[0].lineRef);

  assert.equal(received.length, 0);
});

test("H1/7. hydration reaching ACTIVE never emits SESSION_STARTED (reload is not Session Start)", async () => {
  const { orchestrator, persistence, eventBus } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveCartDraft("uid-A", makeCartDraftFixture());
  const received = subscribeCollector(eventBus);

  await orchestrator.hydrate("uid-A");

  assert.equal(orchestrator.getSnapshot().session, "active");
  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SESSION_STARTED).length, 0);
});

// ============================================================
// I-M. SUBMISSION_STARTED trigger rules
// ============================================================

test("I1. SUBMISSION_STARTED fires on a real submit attempt", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SUBMISSION_STARTED).length, 1);
});

test("J1. no SUBMISSION_STARTED when blocked by an empty cart", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const received = subscribeCollector(eventBus);

  const result = await orchestrator.submit();

  assert.equal(result.outcome, "BLOCKED");
  assert.equal(received.length, 0);
});

test("K1. no additional SUBMISSION_STARTED when blocked by an already-active submission", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> UNCERTAIN, submission stays non-null
  const received = subscribeCollector(eventBus);

  const result = await orchestrator.submit(); // second call while still unresolved

  assert.equal(result.outcome, "BLOCKED");
  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SUBMISSION_STARTED).length, 0);
});

test("L1. no additional SUBMISSION_STARTED when blocked by an ineligible session (post-CONFIRMED, cart still non-empty)", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> CONFIRMED; Cart is not auto-cleared by Runtime
  assert.equal(orchestrator.getSnapshot().order.status, OrderStatus.CONFIRMED);
  assert.ok(orchestrator.getSnapshot().cart.lines.length > 0);

  const received = subscribeCollector(eventBus);
  const result = await orchestrator.submit(); // session is CONFIRMATION, not ACTIVE

  assert.equal(result.outcome, "BLOCKED");
  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SUBMISSION_STARTED).length, 0);
});

test("M1/5. retryUnknown() never emits SUBMISSION_STARTED", async () => {
  let callCount = 0;
  const callable = createSpyCallable(async () => {
    callCount += 1;
    if (callCount === 1) throw { code: "internal" };
    return { data: validBackendResult() };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> UNCERTAIN
  const received = subscribeCollector(eventBus);

  await orchestrator.retryUnknown();

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SUBMISSION_STARTED).length, 0);
});

// ============================================================
// N-P/3/4. ORDER_OUTCOME_CHANGED mapping
// ============================================================

test("N1. ORDER_OUTCOME_CHANGED(CONFIRMED) with the real customer-safe result", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 2, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.CONFIRMED);
  assert.equal(outcomeEvents[0].payload.result.authoritativeTotal, 30000);
});

test("O1. ORDER_OUTCOME_CHANGED(DECLINED) with a semantic rejection category, never CONFIRMED/UNCERTAIN (3/4)", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "failed-precondition", details: { code: "INSUFFICIENT_STOCK" } };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.DECLINED);
  assert.equal(outcomeEvents[0].payload.rejectionCategory, RejectionCategory.QUANTITY_UNAVAILABLE);
});

test("P1. ORDER_OUTCOME_CHANGED(UNCERTAIN) on a transport/internal failure, never DECLINED/CONFIRMED (3/4)", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.UNCERTAIN);
  assert.equal(Object.prototype.hasOwnProperty.call(outcomeEvents[0].payload, "result"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outcomeEvents[0].payload, "rejectionCategory"), false);
});

test("2. DECLINED is never fabricated from a later snapshot read - it reads NONE, proving snapshot alone cannot represent it", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "failed-precondition", details: { code: "PRODUCT_UNAVAILABLE" } };
  });
  const { orchestrator } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit();

  assert.equal(orchestrator.getSnapshot().order.status, OrderStatus.NONE); // not DECLINED
});

// ============================================================
// Q/S/6. Repeated identical status does not re-emit
// ============================================================

test("Q1/S1/6. UNKNOWN -> retry -> still UNKNOWN emits no second ORDER_OUTCOME_CHANGED", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> UNCERTAIN (1st event)
  const received = subscribeCollector(eventBus); // subscribe AFTER the first event

  await orchestrator.retryUnknown(); // -> still UNCERTAIN

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED).length, 0);
});

// ============================================================
// R. UNKNOWN -> retry -> CONFIRMED emits only CONFIRMED
// ============================================================

test("R1. UNKNOWN -> same-key retry -> CONFIRMED emits exactly one CONFIRMED outcome event on retry", async () => {
  let callCount = 0;
  const callable = createSpyCallable(async () => {
    callCount += 1;
    if (callCount === 1) throw { code: "internal" };
    return { data: validBackendResult() };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> UNCERTAIN
  const received = subscribeCollector(eventBus);

  await orchestrator.retryUnknown(); // -> CONFIRMED

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.CONFIRMED);
});

// ============================================================
// T/U/V. Hydration
// ============================================================

test("T1. hydration with a persisted unresolved attempt emits ORDER_OUTCOME_CHANGED(UNCERTAIN)", async () => {
  const { orchestrator, persistence, eventBus } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "IN_FLIGHT" }));
  const received = subscribeCollector(eventBus);

  await orchestrator.hydrate("uid-A");

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.UNCERTAIN);
});

test("U1/7. hydration with a matching reconciled result emits NO order-outcome event, but snapshot shows CONFIRMED", async () => {
  const { orchestrator, persistence, eventBus } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const sharedKey = "shared-key-000001";
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: sharedKey, status: "IN_FLIGHT" }));
  await persistence.saveAuthoritativeResult("uid-A", sharedKey, makeResultFixture());
  const received = subscribeCollector(eventBus);

  await orchestrator.hydrate("uid-A");

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED).length, 0);
  assert.equal(orchestrator.getSnapshot().order.status, OrderStatus.CONFIRMED);
});

test("V1. hydration anomaly emits BOTH ORDER_OUTCOME_CHANGED(UNCERTAIN) and ANOMALY_DETECTED", async () => {
  const { orchestrator, persistence, eventBus } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: "key-attempt-0001", status: "UNKNOWN" }));
  await persistence.saveAuthoritativeResult("uid-A", "key-result-00001", makeResultFixture());
  const received = subscribeCollector(eventBus);

  await orchestrator.hydrate("uid-A");

  assert.deepEqual(
    received.map((e) => e.type).sort(),
    [ExperienceEventTypes.ANOMALY_DETECTED, ExperienceEventTypes.ORDER_OUTCOME_CHANGED].sort()
  );
  const outcomeEvent = received.find((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvent.payload.status, OrderStatus.UNCERTAIN);
});

// ============================================================
// W-Z/8/9. SESSION_ENDED
// ============================================================

test("W1. SESSION_ENDED fires only on a genuine Runtime SESSION_ENDED result", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> CONFIRMED
  const received = subscribeCollector(eventBus);

  const result = await orchestrator.endSession("CUSTOMER_COMPLETED");

  assert.equal(result.outcome, "SESSION_ENDED");
  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SESSION_ENDED).length, 1);
});

test("X1. Session End blocked (ambiguous outcome) emits no SESSION_ENDED", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit(); // -> UNCERTAIN
  const received = subscribeCollector(eventBus);

  const result = await orchestrator.endSession("CUSTOMER_COMPLETED");

  assert.notEqual(result.outcome, "SESSION_ENDED");
  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SESSION_ENDED).length, 0);
});

test("Y1/9. rejection never automatically ends the session", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "invalid-argument" };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit(); // -> DECLINED

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SESSION_ENDED).length, 0);
  assert.equal(orchestrator.getSnapshot().session, "active"); // back to composing, not ended
});

test("Z1/8. confirmation never automatically ends the session", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit(); // -> CONFIRMED

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.SESSION_ENDED).length, 0);
  assert.equal(orchestrator.getSnapshot().session, "confirmation");
});

// ============================================================
// AA/20. Event ordering
// ============================================================

test("AA1/20. full successful journey emits events in the exact expected order, deterministically", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const received = subscribeCollector(eventBus);

  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit();
  await orchestrator.endSession("CUSTOMER_COMPLETED");

  assert.deepEqual(received.map((e) => e.type), [
    ExperienceEventTypes.SESSION_STARTED,
    ExperienceEventTypes.SUBMISSION_STARTED,
    ExperienceEventTypes.ORDER_OUTCOME_CHANGED,
    ExperienceEventTypes.SESSION_ENDED,
  ]);
});

test("browse-then-cancel journey emits only SESSION_STARTED then SESSION_ENDED", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  const received = subscribeCollector(eventBus);

  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.endSession("CUSTOMER_CANCELLED");

  assert.deepEqual(received.map((e) => e.type), [ExperienceEventTypes.SESSION_STARTED, ExperienceEventTypes.SESSION_ENDED]);
});

// ============================================================
// AB/AC/AD/16. Event payload safety across a full journey
// ============================================================

test("AB1/AC1/AD1/16. no event across a full journey ever leaks identity, raw codes, or raw errors", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  const received = subscribeCollector(eventBus);

  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const submitResult = await orchestrator.submit();
  await orchestrator.endSession("CUSTOMER_COMPLETED");

  for (const event of received) {
    assertNoForbiddenKeys(event, "event " + event.type);
    assertNoForbiddenStringValues(event, "event " + event.type);
  }
  assertNoForbiddenKeys(submitResult, "submit() return value");
});

// ============================================================
// AE. No Runtime reference leakage
// ============================================================

test("AE1. no orchestrator method result ever exposes the raw runtime or eventBus instance", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { orchestrator } = await buildOrchestrator(callable);

  const cart = orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const submitResult = await orchestrator.submit();
  const snapshot = orchestrator.getSnapshot();

  for (const value of [cart, submitResult, snapshot]) {
    const keys = collectAllKeysDeep(value);
    assert.equal(keys.includes("runtime"), false);
    assert.equal(keys.includes("eventBus"), false);
  }
});

// ============================================================
// AF/12/13/14. No second-state-machine behavior
// ============================================================

test("AF1/12/13/14. experienceOrchestrator.js requires nothing from Runtime/Cart/Persistence/Submission/OrderIntent/Session", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceOrchestrator.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets.sort(), ["./experienceEvents", "./experienceProjection", "./experienceTypes"]);
});

test("AF2/13/14. the orchestrator holds no exposed session/submission/payment/fulfillment state accessor", () => {
  const { orchestrator } = buildRawOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  for (const forbiddenAccessor of ["sessionState", "submissionState", "paymentState", "fulfillmentState", "cartState"]) {
    assert.equal(orchestrator[forbiddenAccessor], undefined);
  }
});

// ============================================================
// AG/11. No Firebase/network/timer/DOM
// ============================================================

test("AG1/11. no actual Firebase/network/timer/DOM API usage in experienceOrchestrator.js", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceOrchestrator.js"), "utf8");
  for (const forbiddenUsage of ["require(\"firebase", "indexedDB.", "httpsCallable(", "fetch(", "setTimeout(", "setInterval(", "document.", "window."]) {
    assert.equal(source.includes(forbiddenUsage), false, "must not actually use " + forbiddenUsage);
  }
});

test("10. no idempotency-key-generation-looking code in experienceOrchestrator.js", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceOrchestrator.js"), "utf8");
  for (const token of ["generateidempotencykey", "math.random", "date.now().tostring(36)"]) {
    assert.equal(source.toLowerCase().includes(token), false, "must not generate keys itself: " + token);
  }
});

// ============================================================
// AH. STEP69 projection reuse (not reimplementation)
// ============================================================

test("AH1. CONFIRMED result is whitelisted through STEP69's own reconstruction, not trusted verbatim", async () => {
  const taintedResult = validBackendResult({
    items: [
      {
        productId: "p1",
        productName: "Kopi Susu",
        quantity: 1,
        unitPrice: 15000,
        lineTotal: 15000,
        selectedModifiers: [],
        avgCost: 4000,
      },
    ],
  });
  const callable = createSpyCallable(async () => ({ data: taintedResult }));
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  const outcomeEvent = received.find((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.deepEqual(Object.keys(outcomeEvent.payload.result.items[0]).sort(), [
    "lineTotal",
    "productId",
    "productName",
    "quantity",
    "selectedModifiers",
    "unitPrice",
  ]);
});

// ============================================================
// AI. STEP70 event helper reuse
// ============================================================

test("AI1. the emitted ORDER_OUTCOME_CHANGED event is byte-identical to what STEP70's own helper produces for the same projected order", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit();

  const emitted = received.find((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  const expected = createOrderOutcomeChangedEvent({ status: OrderStatus.CONFIRMED, result: emitted.payload.result });
  assert.deepEqual(emitted, expected);
});

// ============================================================
// AJ. Deterministic dedup behavior (table-driven)
// ============================================================

test("AJ1. dedup memo produces the exact expected emitted-status sequence across a scripted journey", async () => {
  let callCount = 0;
  const callable = createSpyCallable(async () => {
    callCount += 1;
    if (callCount <= 2) throw { code: "internal" }; // stay UNKNOWN twice
    return { data: validBackendResult() };
  });
  const { orchestrator, eventBus } = await buildOrchestrator(callable);
  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const received = subscribeCollector(eventBus);

  await orchestrator.submit(); // UNCERTAIN (emit)
  await orchestrator.retryUnknown(); // still UNCERTAIN (no emit)
  await orchestrator.retryUnknown(); // CONFIRMED (emit)

  const statuses = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED).map((e) => e.payload.status);
  assert.deepEqual(statuses, [OrderStatus.UNCERTAIN, OrderStatus.CONFIRMED]);
});

// ============================================================
// 18. Listener/event mutation cannot affect Runtime
// ============================================================

test("18. a listener cannot mutate the delivered event (frozen) and therefore cannot affect anything downstream", async () => {
  const { orchestrator, eventBus } = await buildOrchestrator(createSpyCallable(async () => ({ data: validBackendResult() })));
  eventBus.subscribe((event) => {
    assert.throws(() => {
      "use strict";
      event.payload.status = "TAMPERED";
    }, TypeError);
  });

  orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await orchestrator.submit();

  assert.equal(orchestrator.getSnapshot().order.status, OrderStatus.CONFIRMED); // unaffected
});

// ============================================================
// Action error handling (unexpected throw defensiveness)
// ============================================================

test("unexpected Runtime throw during submit() never fabricates an outcome or emits an event", async () => {
  const throwingRuntime = {
    getSnapshot: () => ({ cart: { lines: [], customerName: null, notes: null }, submission: null, session: "ACTIVE", authoritativeResult: null, hydrated: true }),
    submit: async () => {
      throw new Error("unexpected");
    },
  };
  const eventBus = createEventBus();
  const orchestrator = createExperienceOrchestrator({ runtime: throwingRuntime, eventBus });
  const received = subscribeCollector(eventBus);

  const result = await orchestrator.submit();

  assert.equal(result.outcome, "ORCHESTRATION_ERROR");
  assert.equal(received.length, 0);
});
