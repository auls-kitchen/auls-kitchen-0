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

// ============================================================
// 25. releaseCustomerContext (U4 Slice 1) - guarded customer-context release
// ============================================================
//
// Not a Session End: no identity rotation, no persistence purge, no
// OrderIntent call, no retry, no hydrate, and an unresolved SubmissionAttempt
// is never touched. ACTIVE and CONFIRMATION are releasable; IDLE has nothing
// to release; UNKNOWN / AWAITING_OUTCOME / not-hydrated are refused.

// A store whose raw record the tests can read, overwrite, and make unreadable.
function createInspectableStore() {
  let value;
  let hasValue = false;
  let failGet = false;
  return {
    async get() {
      if (failGet) throw new Error("store read failed");
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
    peek() {
      return hasValue ? value : undefined;
    },
    poke(val) {
      value = val;
      hasValue = true;
    },
    setFailGet(flag) {
      failGet = flag;
    },
  };
}

// Records the name of every persistence method Runtime calls, in order.
function spyOnPersistence(base) {
  const calls = [];
  const spied = {};
  for (const name of Object.keys(base)) {
    spied[name] = async (...args) => {
      calls.push(name);
      return base[name](...args);
    };
  }
  return { persistence: spied, calls };
}

function okCallable() {
  return createSpyCallable(async () => ({ data: validBackendResult() }));
}

// `overrides` is an optional (realPersistence) => partial persistence.
function createReleaseContext(callable, overrides) {
  const store = createInspectableStore();
  const realPersistence = createPersistenceAdapter(store);
  const spied = spyOnPersistence(wrapPersistence(realPersistence, overrides ? overrides(realPersistence) : {}));
  const hookCalls = [];
  const runtime = createKioskRuntime({
    persistence: spied.persistence,
    callOrderIntent: callable,
    requestAuthReset: async () => { hookCalls.push("requestAuthReset"); },
    stopInteraction: async () => { hookCalls.push("stopInteraction"); },
    neutralIdle: async () => { hookCalls.push("neutralIdle"); },
  });
  return { runtime, store, realPersistence, persistenceCalls: spied.calls, hookCalls, callable };
}

async function driveToActive(ctx, quantity) {
  await ctx.runtime.hydrate("uid-A");
  ctx.runtime.addItem({ productId: "p1", quantity: quantity || 1, selectedModifiers: [] });
  assert.equal(ctx.runtime.getSnapshot().session, ACTIVE);
}

async function driveToConfirmation(ctx) {
  await driveToActive(ctx, 2);
  const result = await ctx.runtime.submit();
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal(ctx.runtime.getSnapshot().session, CONFIRMATION);
}

async function driveToUnknown(ctx) {
  await driveToActive(ctx, 1);
  const result = await ctx.runtime.submit();
  assert.equal(result.outcome, "UNKNOWN");
  assert.equal(ctx.runtime.getSnapshot().session, AWAITING_OUTCOME);
}

function clearRecorded(ctx) {
  ctx.persistenceCalls.length = 0;
  ctx.hookCalls.length = 0;
}

test("R25.1 ACTIVE with lines, name and notes is released: Cart/context cleared, session IDLE, auditable result", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToActive(ctx, 2);
  ctx.runtime.setCustomerName("Sari");
  ctx.runtime.setNotes("less sugar");
  assert.equal(ctx.runtime.getSnapshot().cart.lines.length, 1);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, {
    outcome: "RELEASED",
    fromState: "ACTIVE",
    toState: "IDLE",
    callLog: ["guard", "clearCart", "resetSession"],
  });

  const snapshot = ctx.runtime.getSnapshot();
  assert.equal(snapshot.session, IDLE);
  assert.deepEqual(snapshot.cart.lines, []);
  assert.equal(snapshot.cart.customerName, null);
  assert.equal(snapshot.cart.notes, null);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult, null);
  assert.equal(snapshot.hydrated, true);
});

test("R25.2 ACTIVE release makes no persistence, OrderIntent, auth-reset or interaction-hook call at all", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToActive(ctx, 1);
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "RELEASED");
  assert.deepEqual(ctx.persistenceCalls, []);
  assert.equal(ctx.callable.calls.length, 0);
  assert.deepEqual(ctx.hookCalls, []);
});

test("R25.3 ACTIVE with an empty Cart (after clearCart) is released to IDLE", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToActive(ctx, 1);
  ctx.runtime.clearCart();
  assert.equal(ctx.runtime.getSnapshot().session, ACTIVE); // clearCart leaves the session active
  assert.deepEqual(ctx.runtime.getSnapshot().cart.lines, []);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "RELEASED");
  assert.equal(result.fromState, "ACTIVE");
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
});

test("R25.3b ACTIVE after a definitive rejection (Cart kept, no attempt) is released", async () => {
  const callable = createSpyCallable(async () => {
    throw { code: "invalid-argument" };
  });
  const ctx = createReleaseContext(callable);
  await driveToActive(ctx, 1);
  assert.equal((await ctx.runtime.submit()).outcome, "REJECTED");
  assert.equal(ctx.runtime.getSnapshot().session, ACTIVE);
  assert.equal(ctx.runtime.getSnapshot().cart.lines.length, 1);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "RELEASED");
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
  assert.deepEqual(ctx.runtime.getSnapshot().cart.lines, []);
});

test("R25.3c hydrated ACTIVE (persisted Cart Draft) is released in memory with no persistence call", async () => {
  const ctx = createReleaseContext(okCallable());
  await ctx.realPersistence.saveCartDraft("uid-A", makeCartDraftFixture());
  assert.equal((await ctx.runtime.hydrate("uid-A")).sessionState, ACTIVE);
  const persistedBefore = structuredClone(ctx.store.peek());
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "RELEASED");
  assert.deepEqual(ctx.runtime.getSnapshot().cart.lines, []);
  assert.deepEqual(ctx.persistenceCalls, []);
  // Documented limit: Runtime never writes a Cart Draft, so ACTIVE release has
  // no persisted draft of its own to remove; a draft seeded by another writer
  // is left exactly as it was.
  assert.deepEqual(ctx.store.peek(), persistedBefore);
});

test("R25.4 after an ACTIVE release the next customer starts fresh under the SAME ownerUid, with no rehydrate", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToActive(ctx, 2);
  await ctx.runtime.releaseCustomerContext();
  clearRecorded(ctx);

  ctx.runtime.addItem({ productId: "p2", quantity: 1, selectedModifiers: [] });
  const snapshot = ctx.runtime.getSnapshot();
  assert.equal(snapshot.session, ACTIVE); // a fresh Session started
  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(snapshot.cart.lines[0].productId, "p2"); // nothing left from the previous customer

  assert.equal((await ctx.runtime.submit()).outcome, "SUCCEEDED");
  assert.equal(ctx.callable.calls.length, 1);
  assert.equal(ctx.callable.calls[0].items.length, 1);
  assert.equal(ctx.callable.calls[0].items[0].productId, "p2");
  assert.equal(ctx.store.peek().ownerUidAtWrite, "uid-A"); // identity was never rotated
  assert.equal(ctx.persistenceCalls.includes("load"), false); // no rehydrate
  assert.equal(ctx.persistenceCalls.includes("purgeCustomerContext"), false);
  assert.deepEqual(ctx.hookCalls, []);
});

test("R25.5 CONFIRMATION is released: local authoritativeResult removed, Cart cleared, session IDLE, auditable result", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToConfirmation(ctx);
  assert.equal(ctx.runtime.getSnapshot().cart.lines.length, 1); // a confirmation still carries the Cart lines
  assert.notEqual(ctx.store.peek().authoritativeResult, null);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, {
    outcome: "RELEASED",
    fromState: "CONFIRMATION",
    toState: "IDLE",
    callLog: ["guard", "persistencePrecheck", "removeAuthoritativeResult", "clearCart", "clearAuthoritativeResult", "resetSession"],
  });

  const snapshot = ctx.runtime.getSnapshot();
  assert.equal(snapshot.session, IDLE);
  assert.deepEqual(snapshot.cart.lines, []);
  assert.equal(snapshot.submission, null);
  assert.equal(snapshot.authoritativeResult, null);
  assert.equal(snapshot.hydrated, true);
  assert.equal(ctx.store.peek().authoritativeResult, null); // the local result is really gone from storage
  assert.equal(ctx.store.peek().ownerUidAtWrite, "uid-A");
});

test("R25.6 CONFIRMATION release is a targeted removal only: no purge, no attempt removal, no save, no OrderIntent call, no hooks", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToConfirmation(ctx);
  const backendCalls = ctx.callable.calls.length;
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "RELEASED");
  assert.deepEqual(ctx.persistenceCalls, ["load", "removeAuthoritativeResult"]);
  assert.equal(ctx.callable.calls.length, backendCalls); // the backend order is never touched
  assert.deepEqual(ctx.hookCalls, []); // no auth reset / stopInteraction / neutralIdle
});

test("R25.7 a hydrated CONFIRMATION is released and does not come back on the next hydrate", async () => {
  const ctx = createReleaseContext(okCallable());
  await ctx.realPersistence.saveAuthoritativeResult("uid-A", "fixture-key-0002", makeResultFixture());
  assert.equal((await ctx.runtime.hydrate("uid-A")).sessionState, CONFIRMATION);

  assert.equal((await ctx.runtime.releaseCustomerContext()).outcome, "RELEASED");
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);

  const rebooted = createKioskRuntime({ persistence: createPersistenceAdapter(ctx.store), callOrderIntent: okCallable() });
  const hydrateResult = await rebooted.hydrate("uid-A");
  assert.equal(hydrateResult.sessionState, IDLE);
  assert.equal(rebooted.getSnapshot().authoritativeResult, null);
});

test("R25.8 a fresh IDLE session has nothing to release and nothing is touched", async () => {
  const ctx = createReleaseContext(okCallable());
  await ctx.runtime.hydrate("uid-A");
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, { outcome: "NOTHING_TO_RELEASE", fromState: "IDLE", callLog: ["guard"] });
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
  assert.deepEqual(ctx.persistenceCalls, []);
});

test("R25.9 before hydration nothing is released (fail closed)", async () => {
  const ctx = createReleaseContext(okCallable());
  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, { outcome: "REFUSED", reason: "NOT_HYDRATED", fromState: "IDLE", callLog: ["guard"] });
  assert.equal(ctx.runtime.getSnapshot().hydrated, false);
  assert.deepEqual(ctx.persistenceCalls, []);
});

test("R25.10 a live UNKNOWN attempt is refused and left completely intact - retryUnknown still works with the same key", async () => {
  let callCount = 0;
  const callable = createSpyCallable(async () => {
    callCount += 1;
    if (callCount === 1) throw { code: "internal" };
    return { data: validBackendResult() };
  });
  const ctx = createReleaseContext(callable);
  await driveToUnknown(ctx);
  const before = ctx.runtime.getSnapshot();
  const persistedBefore = structuredClone(ctx.store.peek());
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, { outcome: "REFUSED", reason: "OUTCOME_UNRESOLVED", fromState: "AWAITING_OUTCOME", callLog: ["guard"] });

  const after = ctx.runtime.getSnapshot();
  assert.equal(after.session, AWAITING_OUTCOME);
  assert.equal(after.submission, before.submission); // the very same attempt object
  assert.equal(after.submission.status, "UNKNOWN");
  assert.equal(after.cart.lines.length, 1);
  assert.deepEqual(ctx.persistenceCalls, []);
  assert.deepEqual(ctx.hookCalls, []);
  assert.equal(callable.calls.length, 1); // release did not call the backend
  assert.deepEqual(ctx.store.peek(), persistedBefore);

  const retry = await ctx.runtime.retryUnknown();
  assert.equal(retry.outcome, "SUCCEEDED");
  assert.equal(callable.calls[1].idempotencyKey, before.submission.idempotencyKey); // same key: the attempt was preserved
});

test("R25.11a a hydrated IN_FLIGHT attempt (translated to UNKNOWN) is refused and preserved", async () => {
  const ctx = createReleaseContext(okCallable());
  await ctx.realPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ status: "IN_FLIGHT" }));
  assert.equal((await ctx.runtime.hydrate("uid-A")).sessionState, AWAITING_OUTCOME);
  const before = ctx.runtime.getSnapshot();
  const persistedBefore = structuredClone(ctx.store.peek());
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "OUTCOME_UNRESOLVED");
  assert.equal(ctx.runtime.getSnapshot().submission, before.submission);
  assert.equal(ctx.runtime.getSnapshot().submission.status, "UNKNOWN");
  assert.deepEqual(ctx.persistenceCalls, []);
  assert.deepEqual(ctx.store.peek(), persistedBefore);
});

test("R25.11b a hydration anomaly (mismatched attempt/result keys) is refused and both records are preserved", async () => {
  const ctx = createReleaseContext(okCallable());
  await ctx.realPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: "key-attempt-0001", status: "UNKNOWN" }));
  await ctx.realPersistence.saveAuthoritativeResult("uid-A", "key-result-00001", makeResultFixture());
  assert.equal((await ctx.runtime.hydrate("uid-A")).status, "HYDRATION_ANOMALY");
  const persistedBefore = structuredClone(ctx.store.peek());
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  const snapshot = ctx.runtime.getSnapshot();
  assert.equal(snapshot.session, AWAITING_OUTCOME);
  assert.notEqual(snapshot.submission, null);
  assert.notEqual(snapshot.authoritativeResult, null);
  assert.deepEqual(ctx.persistenceCalls, []);
  assert.deepEqual(ctx.store.peek(), persistedBefore);
});

test("R25.12 a submission still in flight (AWAITING_OUTCOME) is refused and then resolves normally", async () => {
  let resolveBackend;
  const gate = new Promise((resolve) => {
    resolveBackend = resolve;
  });
  const callable = createSpyCallable(() => gate);
  const ctx = createReleaseContext(callable);
  await driveToActive(ctx, 1);

  const pending = ctx.runtime.submit();
  while (callable.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.runtime.getSnapshot().session, AWAITING_OUTCOME);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.deepEqual(result, { outcome: "REFUSED", reason: "OUTCOME_UNRESOLVED", fromState: "AWAITING_OUTCOME", callLog: ["guard"] });
  assert.equal(ctx.runtime.getSnapshot().cart.lines.length, 1);

  resolveBackend({ data: validBackendResult() });
  assert.equal((await pending).outcome, "SUCCEEDED");
  assert.equal(ctx.runtime.getSnapshot().session, CONFIRMATION);
  assert.equal(callable.calls.length, 1);
});

test("R25.13 a failed targeted removal fails closed: REFUSED, memory and storage untouched, and a later retry can succeed", async () => {
  const failing = { on: true };
  const ctx = createReleaseContext(okCallable(), (real) => ({
    async removeAuthoritativeResult(ownerUid) {
      if (failing.on) return { ok: false, code: "WRITE_FAILURE" };
      return real.removeAuthoritativeResult(ownerUid);
    },
  }));
  await driveToConfirmation(ctx);
  const before = ctx.runtime.getSnapshot();
  const persistedBefore = structuredClone(ctx.store.peek());

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "PERSISTENCE_REMOVE_FAILED");
  assert.equal(result.toState, undefined);
  assert.equal(result.callLog.includes("clearCart"), false);

  const after = ctx.runtime.getSnapshot();
  assert.equal(after.session, CONFIRMATION);
  assert.equal(after.authoritativeResult, before.authoritativeResult);
  assert.equal(after.cart.lines.length, before.cart.lines.length);
  assert.deepEqual(ctx.store.peek(), persistedBefore);

  failing.on = false;
  assert.equal((await ctx.runtime.releaseCustomerContext()).outcome, "RELEASED");
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
});

test("R25.14 a throwing removal is treated the same way and never leaks the raw error", async () => {
  const ctx = createReleaseContext(okCallable(), () => ({
    async removeAuthoritativeResult() {
      throw new Error("boom-secret-detail");
    },
  }));
  await driveToConfirmation(ctx);
  const before = ctx.runtime.getSnapshot();

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "PERSISTENCE_REMOVE_FAILED");
  assert.equal(JSON.stringify(result).includes("boom-secret-detail"), false);
  assert.equal(ctx.runtime.getSnapshot().session, CONFIRMATION);
  assert.equal(ctx.runtime.getSnapshot().authoritativeResult, before.authoritativeResult);
});

test("R25.15 an unusable stored record is refused BEFORE any removal, and the raw record is byte-identical afterwards", async () => {
  const cases = [
    {
      label: "UID_MISMATCH",
      reason: "PERSISTED_RECORD_NOT_RELEASABLE",
      tamper: async (ctx) => {
        await createPersistenceAdapter(ctx.store).saveAuthoritativeResult("uid-B", "other-key-00001", makeResultFixture());
      },
    },
    {
      label: "CORRUPT_RECORD",
      reason: "PERSISTED_RECORD_NOT_RELEASABLE",
      tamper: async (ctx) => {
        ctx.store.poke({ garbage: true });
      },
    },
    {
      label: "UNSUPPORTED_SCHEMA",
      reason: "PERSISTED_RECORD_NOT_RELEASABLE",
      tamper: async (ctx) => {
        ctx.store.poke(Object.assign(structuredClone(ctx.store.peek()), { schemaVersion: 999 }));
      },
    },
    {
      label: "READ_FAILURE",
      reason: "PERSISTENCE_READ_FAILED",
      tamper: async (ctx) => {
        ctx.store.setFailGet(true);
      },
    },
  ];

  for (const testCase of cases) {
    const ctx = createReleaseContext(okCallable());
    await driveToConfirmation(ctx);
    await testCase.tamper(ctx);
    const rawBefore = structuredClone(ctx.store.peek());
    const held = ctx.runtime.getSnapshot();
    clearRecorded(ctx);

    const result = await ctx.runtime.releaseCustomerContext();
    assert.equal(result.outcome, "REFUSED", testCase.label);
    assert.equal(result.reason, testCase.reason, testCase.label);
    assert.deepEqual(ctx.persistenceCalls, ["load"], testCase.label); // read only - no removal attempted
    assert.deepEqual(ctx.store.peek(), rawBefore, testCase.label); // never overwritten with a blank record
    const after = ctx.runtime.getSnapshot();
    assert.equal(after.session, CONFIRMATION, testCase.label);
    assert.equal(after.authoritativeResult, held.authoritativeResult, testCase.label);
    assert.equal(after.cart.lines.length, held.cart.lines.length, testCase.label);
  }
});

test("R25.16 a stale persisted SubmissionAttempt beside the result is refused, never turned into a phantom UNKNOWN", async () => {
  const sharedKey = "shared-key-000001";
  const ctx = createReleaseContext(okCallable(), () => ({
    // Simulates hydrate()'s best-effort interim cleanup not sticking.
    async removeSubmissionAttempt() {
      return { ok: false, code: "WRITE_FAILURE" };
    },
  }));
  await ctx.realPersistence.saveSubmissionAttempt("uid-A", makeAttemptFixture({ idempotencyKey: sharedKey, status: "IN_FLIGHT" }));
  await ctx.realPersistence.saveAuthoritativeResult("uid-A", sharedKey, makeResultFixture());
  assert.equal((await ctx.runtime.hydrate("uid-A")).sessionState, CONFIRMATION);
  assert.notEqual(ctx.store.peek().submissionAttempt, null); // the stale attempt really is still stored
  const persistedBefore = structuredClone(ctx.store.peek());
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "PERSISTED_ATTEMPT_PRESENT");
  assert.deepEqual(ctx.persistenceCalls, ["load"]);
  assert.deepEqual(ctx.store.peek(), persistedBefore); // both records preserved
  assert.equal(ctx.runtime.getSnapshot().session, CONFIRMATION);
});

test("R25.17a the session changing during the pre-check read is detected: REFUSED STATE_CHANGED, no removal", async () => {
  const holder = {};
  const ctx = createReleaseContext(okCallable(), (real) => ({
    async load(ownerUid, expiryOptions) {
      const loaded = await real.load(ownerUid, expiryOptions);
      await holder.runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED); // a real Session End sneaks in
      return loaded;
    },
  }));
  holder.runtime = ctx.runtime;
  await driveToConfirmation(ctx);
  clearRecorded(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "STATE_CHANGED");
  assert.equal(result.callLog.includes("removeAuthoritativeResult"), false);
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
  assert.equal((await ctx.runtime.releaseCustomerContext()).outcome, "NOTHING_TO_RELEASE"); // the in-flight guard was released
});

test("R25.17b the session changing during the removal is detected: REFUSED STATE_CHANGED, no further mutation", async () => {
  const holder = {};
  const ctx = createReleaseContext(okCallable(), (real) => ({
    async removeAuthoritativeResult(ownerUid) {
      if (!holder.entered) {
        holder.entered = true;
        await holder.runtime.requestSessionEnd(EventTypes.CUSTOMER_COMPLETED);
      }
      return real.removeAuthoritativeResult(ownerUid);
    },
  }));
  holder.runtime = ctx.runtime;
  await driveToConfirmation(ctx);

  const result = await ctx.runtime.releaseCustomerContext();
  assert.equal(result.outcome, "REFUSED");
  assert.equal(result.reason, "STATE_CHANGED");
  assert.equal(result.callLog.includes("resetSession"), false);
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
});

test("R25.18 two concurrent CONFIRMATION releases: exactly one releases, one removal, the other is refused", async () => {
  const ctx = createReleaseContext(okCallable());
  await driveToConfirmation(ctx);
  clearRecorded(ctx);

  const results = await Promise.all([ctx.runtime.releaseCustomerContext(), ctx.runtime.releaseCustomerContext()]);
  const outcomes = results.map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ["REFUSED", "RELEASED"]);
  assert.equal(results.find((r) => r.outcome === "REFUSED").reason, "RELEASE_IN_PROGRESS");
  assert.equal(ctx.persistenceCalls.filter((name) => name === "removeAuthoritativeResult").length, 1);
  assert.equal(ctx.runtime.getSnapshot().session, IDLE);
});

test("R25.19 structural: the release code cannot reach Session End, identity, purge, retry, hydrate, OrderIntent, or the attempt", () => {
  const source = fs.readFileSync(path.join(__dirname, "kioskRuntime.js"), "utf8");
  const start = source.indexOf("function releaseResult(");
  const end = source.indexOf("function getSnapshot()");
  assert.ok(start > 0 && end > start, "release code markers must be found");
  const code = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  for (const forbidden of [
    "requestSessionEnd",
    "endSession",
    "requestAuthReset",
    "requestAuthResetDep",
    "stopInteractionDep",
    "neutralIdleDep",
    "purgeCustomerContext",
    "removeSubmissionAttempt",
    "clearTerminalAttempt",
    "retryUnknown",
    "retryUnknownAttempt",
    "hydrate",
    "submitNewAttempt",
    "callOrderIntent",
    "saveSubmissionAttempt",
    "saveAuthoritativeResult",
    "saveCartDraft",
    "markUnknown",
  ]) {
    assert.equal(new RegExp("\\b" + forbidden + "\\b").test(code), false, "release code must not name " + forbidden);
  }
  // The only persistence members it may use: a read, and the targeted removal.
  const persistenceMembers = [...new Set([...code.matchAll(/persistence\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(persistenceMembers, ["load", "removeAuthoritativeResult"]);
  // It never assigns (and so can never discard) the SubmissionAttempt.
  assert.equal(/submissionState\s*=[^=]/.test(code), false, "release code must never assign submissionState");
});
