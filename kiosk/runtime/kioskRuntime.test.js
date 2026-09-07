"use strict";

/**
 * Kiosk Runtime Coordinator composition tests (STEP 62).
 *
 * Run with: node --test kiosk/runtime/kioskRuntime.test.js
 * No new dependencies - Node's built-in test runner only. No DOM, no
 * real Firebase, no real IndexedDB, no real Auth SDK, no real network
 * call: persistence uses the REAL createPersistenceAdapter over a plain
 * in-memory store (same {get,set,delete} contract IndexedDB satisfies -
 * STEP 56 precedent), and OrderIntent uses a controlled fake callable
 * (STEP 58 precedent). This is composition-level coverage only - it does
 * not re-test any of the five modules' own internal logic, which already
 * has its own dedicated, passing test suite.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createKioskRuntime, EventTypes, SessionStates } = require("./kioskRuntime");
const { createPersistenceAdapter } = require("../persistence/persistenceAdapter");

const { IDLE, ACTIVE, AWAITING_OUTCOME, CONFIRMATION } = SessionStates;

// --- fixtures / helpers ---

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
          productName: "Kopi",
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
      items: [
        { productId: "p1", productName: "Kopi", quantity: 1, unitPrice: 15000, lineTotal: 15000, selectedModifiers: [] },
      ],
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

function createRuntime(callOrderIntent, extraDeps) {
  const store = createInMemoryStore();
  const persistence = createPersistenceAdapter(store);
  const runtime = createKioskRuntime(Object.assign({ persistence, callOrderIntent }, extraDeps));
  return { runtime, persistence, store };
}

function wrapPersistence(base, overrides) {
  return Object.assign({}, base, overrides);
}

async function buildToUnknown(runtime, callable) {
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  return runtime.submit();
}

// ============================================================
// 1. Fresh startup
// ============================================================

test("R1. fresh startup with no persisted context hydrates to empty/IDLE", async () => {
  const { runtime } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  const result = await runtime.hydrate("uid-A");
  assert.equal(result.status, "EMPTY");
  assert.equal(result.sessionState, IDLE);
  const snapshot = runtime.getSnapshot();
  assert.deepEqual(snapshot.cart.lines, []);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult, null);
  assert.equal(snapshot.session, IDLE);
  assert.equal(snapshot.hydrated, true);
});

// ============================================================
// 2. Cart hydration
// ============================================================

test("R2. persisted Cart Draft is hydrated verbatim and starts Session ACTIVE when it has lines", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveCartDraft("uid-A", makeCartDraftFixture());
  const result = await runtime.hydrate("uid-A");
  assert.equal(result.status, "VALID");
  assert.equal(result.sessionState, ACTIVE);
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(snapshot.cart.lines[0].productId, "p1");
  assert.equal(snapshot.session, ACTIVE);
});

// ============================================================
// 3. Cart -> Submission transformation
// ============================================================

test("R3. Cart -> Submission drops localLineId/displaySnapshot, keeps only the contract fields", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({
    productId: "p1",
    quantity: 2,
    selectedModifiers: [{ groupId: "g1", optionId: "a" }],
    displaySnapshot: { name: "Kopi", price: 15000 },
  });
  await runtime.submit();

  assert.equal(callable.calls.length, 1);
  const sentItem = callable.calls[0].items[0];
  assert.deepEqual(Object.keys(sentItem).sort(), ["productId", "quantity", "selectedModifiers"]);
  assert.equal(sentItem.productId, "p1");
  assert.equal(sentItem.quantity, 2);
  assert.deepEqual(sentItem.selectedModifiers, [{ groupId: "g1", optionId: "a" }]);
});

// ============================================================
// 4. First Cart item starts Session
// ============================================================

test("R4. first Cart item transitions Session IDLE -> ACTIVE", async () => {
  const { runtime } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await runtime.hydrate("uid-A");
  assert.equal(runtime.getSnapshot().session, IDLE);
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  assert.equal(runtime.getSnapshot().session, ACTIVE);
});

// ============================================================
// 5. Successful submission
// ============================================================

test("R5. successful submission stores the authoritative result and reaches CONFIRMATION", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 2, selectedModifiers: [] });

  const result = await runtime.submit();
  assert.equal(result.outcome, "SUCCEEDED");
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, CONFIRMATION);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult.authoritativeTotal, 30000);
});

// ============================================================
// 6. Rejected submission
// ============================================================

test("R6. definitive rejection returns customer to ACTIVE with an empty submission", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "invalid-argument" };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  const result = await runtime.submit();
  assert.equal(result.outcome, "REJECTED");
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, ACTIVE);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.cart.lines.length, 1); // Cart is not auto-cleared - customer may retry
});

// ============================================================
// 7. UNKNOWN submission
// ============================================================

test("R7. response-lost failure is classified UNKNOWN and Session stays AWAITING_OUTCOME", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  const result = await runtime.submit();
  assert.equal(result.outcome, "UNKNOWN");
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, AWAITING_OUTCOME);
  assert.equal(snapshot.submission.status, "UNKNOWN");
});

// ============================================================
// 8. UNKNOWN retry preserves exact key/content
// ============================================================

test("R8. retryUnknown reuses the exact same idempotencyKey and content, then can succeed", async () => {
  let callCount = 0;
  const callable = createSpyCallable(async () => {
    callCount += 1;
    if (callCount === 1) throw { code: "internal" };
    return { data: validBackendResult() };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  await runtime.submit();
  const unknownKey = runtime.getSnapshot().submission.idempotencyKey;
  assert.equal(callable.calls[0].idempotencyKey, unknownKey);

  const retryResult = await runtime.retryUnknown();
  assert.equal(retryResult.outcome, "SUCCEEDED");
  assert.equal(callable.calls[1].idempotencyKey, unknownKey); // exact same key on retry
  assert.equal(runtime.getSnapshot().session, CONFIRMATION);
});

// ============================================================
// 9. Persistence write failure blocks network call
// ============================================================

test("R9. persistence write-ahead failure blocks the network call entirely and never reverts to ACTIVE", async () => {
  const store = createInMemoryStore();
  const realPersistence = createPersistenceAdapter(store);
  const failingPersistence = wrapPersistence(realPersistence, {
    async saveSubmissionAttempt() {
      return { ok: false, code: "WRITE_FAILURE" };
    },
  });
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const runtime = createKioskRuntime({ persistence: failingPersistence, callOrderIntent: callable });
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  const result = await runtime.submit();
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(callable.calls.length, 0); // network call never happened
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, AWAITING_OUTCOME); // never reverted to ACTIVE
  assert.equal(snapshot.submission.status, "IN_FLIGHT"); // still unresolved in memory
});

// ============================================================
// 10. Hydrated IN_FLIGHT becomes UNKNOWN
// ============================================================

test("R10. a persisted IN_FLIGHT attempt is translated to UNKNOWN at hydration via the existing markUnknown()", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "IN_FLIGHT" }));

  const result = await runtime.hydrate("uid-A");
  assert.equal(result.sessionState, AWAITING_OUTCOME);
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.submission.status, "UNKNOWN");
  assert.equal(snapshot.submission.idempotencyKey, "fixture-key-0001");
  assert.deepEqual(snapshot.submission.items, makeAttemptFixture().items);
});

// ============================================================
// 11. Hydrated UNKNOWN remains UNKNOWN
// ============================================================

test("R11. a persisted UNKNOWN attempt is hydrated as-is, no extra transition applied", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "UNKNOWN" }));

  const result = await runtime.hydrate("uid-A");
  assert.equal(result.sessionState, AWAITING_OUTCOME);
  assert.equal(runtime.getSnapshot().submission.status, "UNKNOWN");
});

// ============================================================
// 12. Hydrated authoritativeResult enters CONFIRMATION
// ============================================================

test("R12. a persisted authoritativeResult with no submissionAttempt hydrates to CONFIRMATION", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveAuthoritativeResult("uid-A", "fixture-key-0002", makeResultFixture());

  const result = await runtime.hydrate("uid-A");
  assert.equal(result.sessionState, CONFIRMATION);
  assert.equal(runtime.getSnapshot().authoritativeResult.authoritativeTotal, 15000);
  assert.equal(runtime.getSnapshot().submission, null);
});

// ============================================================
// 13. Matching result + stale IN_FLIGHT does not retry
// ============================================================

test("R13. matching idempotencyKey: authoritativeResult wins, stale attempt cleared, retry forbidden", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  const sharedKey = "shared-key-000001";
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: sharedKey, status: "IN_FLIGHT" }));
  await persistence.saveAuthoritativeResult("uid-A", sharedKey, makeResultFixture());

  const result = await runtime.hydrate("uid-A");
  assert.equal(result.status, "VALID");
  assert.equal(result.sessionState, CONFIRMATION);

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, CONFIRMATION);
  assert.equal(snapshot.submission, null); // stale attempt cleared, not silently kept
  assert.equal(snapshot.authoritativeResult.orderState, "VALIDATED");

  const retryResult = await runtime.retryUnknown();
  assert.equal(retryResult.outcome, "BLOCKED");
  assert.equal(retryResult.category, "CANNOT_RETRY"); // retry forbidden once resolved

  const reloaded = await persistence.load("uid-A");
  assert.equal(reloaded.submissionAttempt, null); // interim cleanup actually persisted
});

// ============================================================
// 14. Non-matching result/attempt is not silently resolved
// ============================================================

test("R14. mismatched idempotencyKey between attempt and result is surfaced as an anomaly, never guessed", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: "key-attempt-0001", status: "UNKNOWN" }));
  await persistence.saveAuthoritativeResult("uid-A", "key-result-00001", makeResultFixture());

  const result = await runtime.hydrate("uid-A");
  assert.equal(result.status, "HYDRATION_ANOMALY");
  assert.equal(result.reason, "SUBMISSION_RESULT_KEY_MISMATCH");
  assert.equal(result.submissionAttempt.idempotencyKey, "key-attempt-0001");
  assert.equal(result.authoritativeResult.idempotencyKey, "key-result-00001");

  const snapshot = runtime.getSnapshot();
  // Neither record is silently discarded, and Session is derived
  // conservatively (unresolved submission still blocks ending), never as
  // an un-earned CONFIRMATION.
  assert.notEqual(snapshot.submission, null);
  assert.notEqual(snapshot.authoritativeResult, null);
  assert.equal(snapshot.session, AWAITING_OUTCOME);
});

// ============================================================
// 15. Session End while UNKNOWN is blocked
// ============================================================

test("R15. Session End is blocked while a submission is UNKNOWN", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  await buildToUnknown(runtime, callable);
  assert.equal(runtime.getSnapshot().session, AWAITING_OUTCOME);

  const result = await runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
  assert.equal(result.outcome, "BLOCKED");
  // still AWAITING_OUTCOME with the submission intact - nothing was reset
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, AWAITING_OUTCOME);
  assert.notEqual(snapshot.submission, null);
});

// ============================================================
// 16. Session End exact reset order
// ============================================================

test("R16. a clean Session End runs the exact locked reset order and purges storage", async () => {
  const calls = [];
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const store = createInMemoryStore();
  const persistence = createPersistenceAdapter(store);
  const runtime = createKioskRuntime({
    persistence,
    callOrderIntent: callable,
    stopInteraction: async () => { calls.push("stopInteraction"); },
    requestAuthReset: async () => { calls.push("requestAuthReset"); },
    neutralIdle: async () => { calls.push("neutralIdle"); },
  });
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await runtime.submit();
  assert.equal(runtime.getSnapshot().session, CONFIRMATION);

  const result = await runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
  assert.equal(result.outcome, "SESSION_ENDED");
  assert.deepEqual(result.callLog, [
    "stopInteraction",
    "ambiguityGuard",
    "clearCart",
    "clearTerminalSubmission",
    "clearAuthoritativeResult",
    "purgePersistence",
    "resetSession",
    "requestAuthReset",
    "neutralIdle",
  ]);

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.session, IDLE);
  assert.deepEqual(snapshot.cart.lines, []);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult, null);

  const reloaded = await persistence.load("uid-A");
  assert.equal(reloaded.status, "EMPTY"); // storage actually purged
});

// ============================================================
// 17. Reset failure prevents Auth Reset
// ============================================================

test("R17. a failing cleanup step reports RESET_INCOMPLETE and never calls Auth Reset", async () => {
  const calls = [];
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const store = createInMemoryStore();
  const realPersistence = createPersistenceAdapter(store);
  const failingPersistence = wrapPersistence(realPersistence, {
    async purgeCustomerContext() {
      return { ok: false, code: "DELETE_FAILURE" };
    },
  });
  const runtime = createKioskRuntime({
    persistence: failingPersistence,
    callOrderIntent: callable,
    requestAuthReset: async () => { calls.push("requestAuthReset"); },
  });
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await runtime.submit();

  const result = await runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  assert.equal(calls.includes("requestAuthReset"), false);
  assert.ok(result.reason.some((r) => r.step === "purgePersistence"));
});

// ============================================================
// 18. Auth Reset only occurs after successful customer-data cleanup
// ============================================================

test("R18. Auth Reset is invoked exactly once, only on a fully clean reset", async () => {
  let authResetCalls = 0;
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { runtime } = createRuntime(callable, { requestAuthReset: async () => { authResetCalls += 1; } });
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await runtime.submit();

  const result = await runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
  assert.equal(result.outcome, "SESSION_ENDED");
  assert.equal(authResetCalls, 1);
});

// ============================================================
// 19. requestSessionEnd throw is never treated as success
// ============================================================

test("R19. a throwing stopInteraction is defensively caught and never reported as SESSION_ENDED", async () => {
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const { runtime } = createRuntime(callable, {
    stopInteraction: async () => {
      throw new Error("UI lock failed");
    },
  });
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  await runtime.submit();
  assert.equal(runtime.getSnapshot().session, CONFIRMATION);

  const result = await runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
  assert.notEqual(result.outcome, "SESSION_ENDED");
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  // Runtime's own composed state is untouched - it never adopted IDLE.
  assert.equal(runtime.getSnapshot().session, CONFIRMATION);
});

// ============================================================
// 20. Dependency boundary
// ============================================================

test("R20. dependency boundary: only real Kiosk module requires; persistence itself stays injected", () => {
  const source = fs.readFileSync(path.join(__dirname, "kioskRuntime.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  const allowed = [
    "../cart/cartTypes",
    "../cart/cartReducer",
    "../submission/submissionTypes",
    "../submission/submissionMachine",
    "../orderIntent/orderIntentAdapter",
    "../persistence/persistenceTypes",
    "../session/sessionMachine",
  ];
  for (const target of requireTargets) {
    assert.ok(allowed.includes(target), "unexpected require target: " + target);
  }
  assert.equal(requireTargets.includes("../persistence/persistenceAdapter"), false);
  assert.equal(requireTargets.includes("../persistence/indexedDbAdapter"), false);
});

// ============================================================
// 21. No Runtime-generated replacement idempotency key during UNKNOWN
// ============================================================

test("R21. Runtime never generates its own idempotencyKey - UNKNOWN keeps the adapter-generated one", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  await runtime.submit();
  const keyAfterUnknown = runtime.getSnapshot().submission.idempotencyKey;
  assert.ok(typeof keyAfterUnknown === "string" && keyAfterUnknown.length > 0);

  // kioskRuntime.js's own source never calls a key-generation function -
  // it has no such capability at all (mirrors E20's style from STEP 58).
  const source = fs.readFileSync(path.join(__dirname, "kioskRuntime.js"), "utf8");
  for (const token of ["generateidempotencykey", "math.random", "date.now().tostring(36)"]) {
    assert.equal(source.toLowerCase().includes(token), false, "must not generate keys itself: " + token);
  }
});

// ============================================================
// 22. Cart mutation after submission does not mutate attempt snapshot
// ============================================================

test("R22. a Cart edit after submission never changes the captured attempt content", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "internal" };
  });
  const { runtime } = createRuntime(callable);
  await runtime.hydrate("uid-A");
  runtime.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });

  await runtime.submit(); // -> UNKNOWN, attempt captured with just p1
  runtime.addItem({ productId: "p2", quantity: 5, selectedModifiers: [] }); // live Cart edit afterward

  const callableSuccess = createSpyCallable(async () => ({ data: validBackendResult() }));
  // swap in a succeeding callable for the retry by re-creating runtime is
  // not possible mid-flow, so instead assert directly on the still-UNKNOWN
  // snapshot and on the payload actually captured at submit time.
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.submission.items.length, 1);
  assert.equal(snapshot.submission.items[0].productId, "p1");
  assert.equal(callable.calls[0].items.length, 1); // original network payload never saw p2
  assert.equal(snapshot.cart.lines.length, 2); // Cart itself legitimately has both lines now
});

// ============================================================
// 23. Locally expired unresolved attempt remains unresolved
// ============================================================

test("R23. local expiry is informational only - an expired unresolved attempt is not treated as failure", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "UNKNOWN" }));

  const result = await runtime.hydrate("uid-A", { submissionAttemptMaxAgeMs: 0 });
  assert.equal(result.sessionState, AWAITING_OUTCOME); // unchanged by expiry
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.submission.status, "UNKNOWN"); // still unresolved, not auto-failed
  assert.equal(snapshot.submission.idempotencyKey, "fixture-key-0001");
});

// ============================================================
// 24. UID mismatch does not expose foreign customer state
// ============================================================

test("R24. hydrating under a different ownerUid never exposes the other owner's data", async () => {
  const { runtime, persistence } = createRuntime(createSpyCallable(async () => ({ data: validBackendResult() })));
  await persistence.saveCartDraft("uid-A", makeCartDraftFixture());
  await persistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "UNKNOWN" }));

  const result = await runtime.hydrate("uid-B");
  assert.equal(result.status, "UID_MISMATCH");
  const snapshot = runtime.getSnapshot();
  assert.deepEqual(snapshot.cart.lines, []);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult, null);
  assert.equal(snapshot.session, IDLE);
});
