"use strict";

/**
 * Kiosk Host / Bootstrap tests (STEP 74).
 *
 * Run with: node --test kiosk/host/kioskHost.test.js
 * No new dependencies - Node's built-in test runner only. No real
 * Firebase, no browser, no IndexedDB - `store` is a plain in-memory
 * fake and `auth` is a fake resolveOwnerUid()/requestAuthReset()
 * object, exactly the injection seams STEP 74 requires this module to
 * expose so it is testable without a new toolchain.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createKioskHost, BootstrapStatus } = require("./kioskHost");
const { createPersistenceAdapter } = require("../persistence/persistenceAdapter");
const { EventTypes: ExperienceEventTypes } = require("../experience/experienceEvents");
const { OrderStatus } = require("../experience/experienceTypes");

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
          selectedModifiers: [],
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

// A fake Auth adapter: resolveOwnerUid() returns UIDs from a queue (or a
// fixed one if only one is given); requestAuthReset() just counts calls.
// This is exactly the injected seam a real Firebase-Auth-backed
// implementation would satisfy - never constructed by Host itself.
function createFakeAuth(uidQueue) {
  const queue = Array.isArray(uidQueue) ? uidQueue.slice() : [uidQueue];
  const resetCalls = [];
  return {
    async resolveOwnerUid() {
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    async requestAuthReset() {
      resetCalls.push(Date.now());
    },
    _resetCalls: resetCalls,
  };
}

function subscribeCollector(orchestrator) {
  const received = [];
  orchestrator.subscribe((event) => received.push(event));
  return received;
}

// ============================================================
// A. Constructor / dependency validation
// ============================================================

test("A1. constructor requires store, callOrderIntent, and auth.resolveOwnerUid", () => {
  assert.throws(() => createKioskHost({}), TypeError);
  assert.throws(() => createKioskHost({ store: createInMemoryStore() }), TypeError);
  assert.throws(
    () => createKioskHost({ store: createInMemoryStore(), callOrderIntent: async () => ({}) }),
    TypeError
  );
  assert.throws(
    () => createKioskHost({ store: createInMemoryStore(), callOrderIntent: async () => ({}), auth: {} }),
    TypeError
  );
});

test("A2. constructor succeeds and exposes exactly {orchestrator, beginCustomerSession, getBootstrapStatus}", () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });
  assert.deepEqual(Object.keys(host).sort(), ["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
});

test("A3. bootstrap status starts as BOOTSTRAPPING before any session begins", () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });
  assert.equal(host.getBootstrapStatus(), BootstrapStatus.BOOTSTRAPPING);
});

// ============================================================
// B. Ready semantics - Host bootstrap status vs ExperienceSnapshot.ready
// ============================================================

test("B1. bootstrap status becomes READY only after a successful beginCustomerSession, matching ExperienceSnapshot.ready", async () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });

  const result = await host.beginCustomerSession();

  assert.equal(result.status, BootstrapStatus.READY);
  assert.equal(host.getBootstrapStatus(), BootstrapStatus.READY);
  assert.equal(host.orchestrator.getSnapshot().ready, true);
});

// ============================================================
// C. Runtime/Orchestrator lifetime proof - one Host spans multiple
//    sequential Customer Sessions
// ============================================================

test("C1. one Host instance safely spans two sequential customer sessions with full isolation", async () => {
  const store = createInMemoryStore();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const auth = createFakeAuth(["uid-A", "uid-B"]);
  const host = createKioskHost({ store, callOrderIntent: callable, auth });
  const orchestratorRef = host.orchestrator;
  const received = subscribeCollector(host.orchestrator);

  // Customer A
  await host.beginCustomerSession();
  host.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const submitResultA = await host.orchestrator.submit();
  assert.equal(submitResultA.outcome, "SUCCEEDED");
  assert.equal(host.orchestrator.getSnapshot().order.status, OrderStatus.CONFIRMED);
  const endResultA = await host.orchestrator.endSession("CUSTOMER_COMPLETED");
  assert.equal(endResultA.outcome, "SESSION_ENDED");

  // Customer B - same Host, same Runtime, same Orchestrator, NEW ownerUid
  const beginResultB = await host.beginCustomerSession();
  assert.equal(beginResultB.status, BootstrapStatus.READY);

  // Same Orchestrator instance throughout - Host never reconstructed the chain
  assert.equal(host.orchestrator, orchestratorRef);

  // Customer B inherits NOTHING from Customer A
  const snapshotB = host.orchestrator.getSnapshot();
  assert.deepEqual(snapshotB.cart.lines, []);
  assert.equal(snapshotB.order.status, OrderStatus.NONE); // not CONFIRMED - correctly re-baselined
  assert.equal(snapshotB.order.result, null);
  assert.equal(snapshotB.session, "idle");

  // ownerUid itself never appears anywhere in what Host/Orchestrator expose
  assert.equal(JSON.stringify(snapshotB).includes("uid-A"), false);
  assert.equal(JSON.stringify(snapshotB).includes("uid-B"), false);
  assert.equal(JSON.stringify(beginResultB).includes("uid-B"), false);

  // Dedup-memo reset proof: Customer B reaching CONFIRMED again must
  // still emit its OWN ORDER_OUTCOME_CHANGED(CONFIRMED) - if the memo
  // had NOT been reset on Customer A's Session End, this would be
  // incorrectly suppressed as "no change".
  host.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await host.orchestrator.submit();
  const confirmedEventsForB = received.filter(
    (e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED && e.payload.status === OrderStatus.CONFIRMED
  );
  assert.equal(confirmedEventsForB.length, 2); // once for A, once for B
});

// ============================================================
// D. Subscription-before-hydrate proof
// ============================================================

test("D1. a consumer subscribed BEFORE beginCustomerSession receives the hydration-time UNCERTAIN outcome event", async () => {
  const store = createInMemoryStore();
  const seedingPersistence = createPersistenceAdapter(store); // test-only setup, not part of Host's API
  await seedingPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "IN_FLIGHT" }));

  const host = createKioskHost({
    store,
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });
  const received = subscribeCollector(host.orchestrator); // subscribe BEFORE hydrate

  await host.beginCustomerSession();

  const outcomeEvents = received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED);
  assert.equal(outcomeEvents.length, 1);
  assert.equal(outcomeEvents[0].payload.status, OrderStatus.UNCERTAIN);
});

test("D2. (negative proof) subscribing AFTER beginCustomerSession MISSES the hydration-time event entirely", async () => {
  const store = createInMemoryStore();
  const seedingPersistence = createPersistenceAdapter(store);
  await seedingPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "IN_FLIGHT" }));

  const host = createKioskHost({
    store,
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });

  await host.beginCustomerSession(); // hydrate runs first, with no subscriber yet
  const received = subscribeCollector(host.orchestrator); // subscribe AFTER hydrate - too late

  assert.equal(received.filter((e) => e.type === ExperienceEventTypes.ORDER_OUTCOME_CHANGED).length, 0);
  // the underlying fact is still true as STATE, proving the event, not the fact, was missed
  assert.equal(host.orchestrator.getSnapshot().order.status, OrderStatus.UNCERTAIN);
});

test("D3. a pre-subscribed consumer receives BOTH events on a genuine hydration anomaly", async () => {
  const store = createInMemoryStore();
  const seedingPersistence = createPersistenceAdapter(store);
  await seedingPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: "key-attempt-0001", status: "UNKNOWN" }));
  await seedingPersistence.saveAuthoritativeResult("uid-A", "key-result-00001", makeResultFixture());

  const host = createKioskHost({
    store,
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-A"),
  });
  const received = subscribeCollector(host.orchestrator);

  await host.beginCustomerSession();

  assert.deepEqual(
    received.map((e) => e.type).sort(),
    [ExperienceEventTypes.ANOMALY_DETECTED, ExperienceEventTypes.ORDER_OUTCOME_CHANGED].sort()
  );
});

// ============================================================
// E. Multi-Kiosk isolation proof
// ============================================================

test("E1. two Host instances are fully independent - different Runtime/Orchestrator/EventBus, no cross-delivery, no shared state", async () => {
  const hostA = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-kiosk-A"),
  });
  const hostB = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-kiosk-B"),
  });

  assert.notEqual(hostA.orchestrator, hostB.orchestrator);

  const receivedA = subscribeCollector(hostA.orchestrator);
  const receivedB = subscribeCollector(hostB.orchestrator);

  await hostA.beginCustomerSession();
  hostA.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  assert.ok(receivedA.length > 0);
  assert.equal(receivedB.length, 0); // hostB never saw hostA's events

  await hostB.beginCustomerSession();
  assert.deepEqual(hostB.orchestrator.getSnapshot().cart.lines, []); // unaffected by hostA's cart
});

// ============================================================
// F. Failure proofs - bootstrap failure never claims ready
// ============================================================

test("F1. Auth resolution rejecting -> FAILED, ready stays false, no hydrate side effects", async () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: {
      resolveOwnerUid: async () => {
        throw new Error("auth backend unreachable");
      },
    },
  });

  const result = await host.beginCustomerSession();

  assert.equal(result.status, BootstrapStatus.FAILED);
  assert.equal(host.getBootstrapStatus(), BootstrapStatus.FAILED);
  assert.equal(host.orchestrator.getSnapshot().ready, false);
});

test("F2. Auth resolving an empty/invalid ownerUid -> FAILED, never proceeds to hydrate", async () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: { resolveOwnerUid: async () => "" },
  });

  const result = await host.beginCustomerSession();

  assert.equal(result.status, BootstrapStatus.FAILED);
  assert.equal(host.orchestrator.getSnapshot().ready, false);
});

test("F3. missing `store` dependency throws at construction - never produces a partially-bootstrapped Host", () => {
  assert.throws(
    () => createKioskHost({ callOrderIntent: createSpyCallable(async () => ({})), auth: createFakeAuth("uid-A") }),
    TypeError
  );
});

test("F4. missing `callOrderIntent` dependency throws at construction", () => {
  assert.throws(() => createKioskHost({ store: createInMemoryStore(), auth: createFakeAuth("uid-A") }), TypeError);
});

// ============================================================
// G. Forbidden dependency scan
// ============================================================

test("G1. kioskHost.js requires only the four expected composition-root modules, nothing else", () => {
  const source = fs.readFileSync(path.join(__dirname, "kioskHost.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets.sort(), [
    "../experience/experienceEventBus",
    "../experience/experienceOrchestrator",
    "../persistence/persistenceAdapter",
    "../runtime/kioskRuntime",
  ]);
});

test("G2. no actual Firebase/UI/payment/business-logic API usage in kioskHost.js", () => {
  const source = fs.readFileSync(path.join(__dirname, "kioskHost.js"), "utf8");
  for (const forbiddenUsage of [
    "require(\"firebase",
    "initializeApp(",
    "getAuth(",
    "signInAnonymously(",
    "httpsCallable(",
    "indexedDB.",
    "document.",
    "window.",
    "midtrans",
    "qris",
  ]) {
    assert.equal(source.toLowerCase().includes(forbiddenUsage.toLowerCase()), false, "must not actually use " + forbiddenUsage);
  }
});

test("H1. Host never exposes ownerUid through any of its own return values", async () => {
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createSpyCallable(async () => ({ data: validBackendResult() })),
    auth: createFakeAuth("uid-super-secret"),
  });

  const beginResult = await host.beginCustomerSession();

  assert.equal(JSON.stringify(beginResult).includes("uid-super-secret"), false);
  assert.equal(JSON.stringify(host.orchestrator.getSnapshot()).includes("uid-super-secret"), false);
});
