"use strict";

/**
 * Kiosk OrderIntent adapter tests (STEP 58).
 *
 * Run with: node --test kiosk/orderIntent/orderIntentAdapter.test.js
 * No new dependencies - Node's built-in test runner only. No real
 * network call, no real Firebase, no production mutation: every
 * backend interaction is a controlled fake/mock the test constructs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { submitNewAttempt, retryUnknownAttempt } = require("./orderIntentAdapter");
const { createPersistenceAdapter } = require("../persistence/persistenceAdapter");
const {
  PROVEN_NO_COMMIT_ERROR_CODES,
  buildOrderIntentRequestPayload,
  isValidAuthoritativeResultShape,
} = require("./orderIntentTypes");

const BACKEND_SRC = path.join(__dirname, "..", "..", "functions", "src");
const REPO_ROOT = path.join(__dirname, "..", "..");

// --- fixtures ---

function validParams(overrides) {
  return Object.assign(
    {
      items: [{ productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
      customerName: "Budi",
      notes: null,
      ownerUid: "uid-A",
    },
    overrides
  );
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
      customerName: "Budi",
      notes: null,
    },
    overrides
  );
}

function createFakePersistence(overrides) {
  const state = { submissionAttempt: null, authoritativeResult: null, calls: [] };
  const base = {
    async saveSubmissionAttempt(ownerUid, attempt) {
      state.calls.push(["saveSubmissionAttempt", ownerUid]);
      state.submissionAttempt = attempt;
      return { ok: true };
    },
    async saveAuthoritativeResult(ownerUid, idempotencyKey, result) {
      state.calls.push(["saveAuthoritativeResult", ownerUid]);
      state.authoritativeResult = { idempotencyKey, result };
      return { ok: true };
    },
    async removeSubmissionAttempt(ownerUid) {
      state.calls.push(["removeSubmissionAttempt", ownerUid]);
      state.submissionAttempt = null;
      return { ok: true };
    },
  };
  const merged = Object.assign({}, base, overrides);
  merged._state = state;
  return merged;
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

function fixedKeyDeps(key) {
  return { generateKey: () => key };
}

// ============================================================
// A. WRITE-AHEAD
// ============================================================

test("A1. persistence succeeds -> backend call allowed", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(callable.calls.length, 1);
});

test("A2. persistence fails -> backend call NOT called", async () => {
  const persistence = createFakePersistence({
    async saveSubmissionAttempt() {
      return { ok: false, code: "WRITE_FAILURE" };
    },
  });
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(callable.calls.length, 0);
  assert.equal(result.outcome, "BLOCKED");
});

test("A3. persistence failure does NOT generate a new key", async () => {
  let generateCalls = 0;
  const deps = { generateKey: () => { generateCalls += 1; return "abcdefgh12345678"; } };
  const persistence = createFakePersistence({
    async saveSubmissionAttempt() {
      return { ok: false, code: "WRITE_FAILURE" };
    },
  });
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const result = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, deps);
  assert.equal(generateCalls, 1);
  assert.equal(result.attempt.idempotencyKey, "abcdefgh12345678");
});

// ============================================================
// B. REQUEST
// ============================================================

test("B4. exact idempotencyKey forwarded", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(callable.calls[0].idempotencyKey, "abcdefgh12345678");
});

test("B5. exact item snapshot forwarded", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.deepEqual(callable.calls[0].items, [
    { productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] },
  ]);
});

test("B6. customerName/notes forwarded", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt(
    { ...validParams({ customerName: "Siti", notes: "extra hot" }), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(callable.calls[0].customerName, "Siti");
  assert.equal(callable.calls[0].notes, "extra hot");
});

test("B7. no Cart displaySnapshot is ever forwarded", () => {
  const payload = buildOrderIntentRequestPayload({
    idempotencyKey: "abcdefgh12345678",
    items: [{ productId: "p1", quantity: 1, selectedModifiers: [], displaySnapshot: { name: "should not leak" } }],
    customerName: null,
    notes: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payload.items[0], "displaySnapshot"), false);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), ["productId", "quantity", "selectedModifiers"].sort());
});

test("B8. no price/HPP/recipe/stock is ever forwarded", () => {
  const payload = buildOrderIntentRequestPayload({
    idempotencyKey: "abcdefgh12345678",
    items: [{ productId: "p1", quantity: 1, selectedModifiers: [] }],
    customerName: null,
    notes: null,
  });
  const forbiddenKeys = ["price", "unitPrice", "lineTotal", "hpp", "recipe", "stock", "authoritativeTotal"];
  const payloadJson = JSON.stringify(payload).toLowerCase();
  for (const key of forbiddenKeys) {
    assert.equal(payloadJson.includes(key.toLowerCase()), false, "payload must never contain " + key);
  }
});

// ============================================================
// C. SUCCESS
// ============================================================

test("C9. successful backend response -> SUCCEEDED", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.outcome, "SUCCEEDED");
});

test("C10. authoritative result preserved exactly", async () => {
  const persistence = createFakePersistence();
  const backendResult = validBackendResult();
  const callable = createSpyCallable(async () => ({ data: backendResult }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.deepEqual(persistence._state.authoritativeResult.result, backendResult);
});

test("C11. key unchanged after success", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.attempt.idempotencyKey, "abcdefgh12345678");
});

test("C12. terminal persistence cleanup does not delete the Authoritative Result", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(persistence._state.submissionAttempt, null); // removed
  assert.notEqual(persistence._state.authoritativeResult, null); // NOT removed
});

// ============================================================
// D. REJECTION
// ============================================================

test("D13. definitive validation rejection -> REJECTED", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "failed-precondition", message: "Insufficient stock.", details: { code: "INSUFFICIENT_STOCK" } };
  });
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reason, "INSUFFICIENT_STOCK");
});

test("D14. rejection does not auto-retry", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "failed-precondition", details: { code: "PRODUCT_UNAVAILABLE" } };
  });
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(callable.calls.length, 1);
});

test("D15. rejection does not generate a new key", async () => {
  let generateCalls = 0;
  const deps = { generateKey: () => { generateCalls += 1; return "abcdefgh12345678"; } };
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "failed-precondition", details: { code: "PRODUCT_UNAVAILABLE" } };
  });
  const result = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, deps);
  assert.equal(generateCalls, 1);
  assert.equal(result.attempt.idempotencyKey, "abcdefgh12345678");
});

// ============================================================
// E. UNKNOWN
// ============================================================

test("E16. transport ambiguity -> UNKNOWN", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { message: "network error" }; // no .code at all - genuine transport failure
  });
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.outcome, "UNKNOWN");
});

test("E17. UNKNOWN preserves the exact key", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "unavailable" };
  });
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.attempt.idempotencyKey, "abcdefgh12345678");
});

test("E18. UNKNOWN preserves the exact submitted content", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "deadline-exceeded" };
  });
  const params = validParams();
  const result = await submitNewAttempt({ ...params, persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.deepEqual(result.attempt.items, params.items);
  assert.equal(result.attempt.customerName, params.customerName);
});

test("E19. UNKNOWN remains persisted (never removed)", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "unavailable" };
  });
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  const removeCalls = persistence._state.calls.filter((c) => c[0] === "removeSubmissionAttempt");
  assert.equal(removeCalls.length, 0);
  assert.notEqual(persistence._state.submissionAttempt, null);
  assert.equal(persistence._state.submissionAttempt.status, "UNKNOWN");
});

test("E20. UNKNOWN never rotates Auth (no such capability exists in this module)", () => {
  const source = fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8");
  for (const token of ["signout", "signin", "rotateauth", "authreset", "firebaseauth", "getauth("]) {
    assert.equal(source.toLowerCase().includes(token), false, "must not reference " + token);
  }
});

test("E21. UNKNOWN never creates a new key", async () => {
  let generateCalls = 0;
  const deps = { generateKey: () => { generateCalls += 1; return "abcdefgh12345678"; } };
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "unavailable" };
  });
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, deps);
  assert.equal(generateCalls, 1);
});

// ============================================================
// F. RETRY
// ============================================================

test("F22-F23-F25. retry uses the exact same key and content, generating no new key", async () => {
  let generateCalls = 0;
  const deps = { generateKey: () => { generateCalls += 1; return "abcdefgh12345678"; } };
  const persistence = createFakePersistence();
  const params = validParams();

  const failingCallable = createSpyCallable(async () => {
    throw { code: "unavailable" };
  });
  const firstResult = await submitNewAttempt({ ...params, persistence, callOrderIntent: failingCallable }, deps);
  assert.equal(firstResult.outcome, "UNKNOWN");

  const recoveringCallable = createSpyCallable(async () => ({ data: validBackendResult() }));
  const retryResult = await retryUnknownAttempt({
    attempt: firstResult.attempt,
    ownerUid: "uid-A",
    persistence,
    callOrderIntent: recoveringCallable,
  });

  assert.equal(generateCalls, 1); // never called again during retry
  assert.equal(recoveringCallable.calls[0].idempotencyKey, "abcdefgh12345678");
  assert.deepEqual(recoveringCallable.calls[0].items, params.items);
  assert.equal(retryResult.outcome, "SUCCEEDED");
});

test("F24. retry does not use the current Cart - only the attempt's own captured content", async () => {
  const persistence = createFakePersistence();
  const original = validParams();
  const deps = fixedKeyDeps("abcdefgh12345678");
  const failing = createSpyCallable(async () => {
    throw { code: "unavailable" };
  });
  const unknownResult = await submitNewAttempt({ ...original, persistence, callOrderIntent: failing }, deps);

  // Simulate "the Cart changed" by passing DIFFERENT items in the retry
  // params - retryUnknownAttempt must never read them.
  const recovering = createSpyCallable(async () => ({ data: validBackendResult() }));
  await retryUnknownAttempt({
    attempt: unknownResult.attempt,
    ownerUid: "uid-A",
    items: [{ productId: "DIFFERENT_PRODUCT", quantity: 99, selectedModifiers: [] }],
    persistence,
    callOrderIntent: recovering,
  });

  assert.deepEqual(recovering.calls[0].items, original.items); // unaffected by the bogus `items` field
});

// ============================================================
// G. RESULT VALIDATION
// ============================================================

test("G26. malformed success response is not accepted as SUCCESS", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: { orderState: "VALIDATED" } })); // missing required fields
  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.notEqual(result.outcome, "SUCCEEDED");
  assert.equal(result.outcome, "UNKNOWN");
});

// ============================================================
// H. DEPENDENCY
// ============================================================

test("H27-H29. no AWR/payment/UI/Firebase/persistence/cart dependency", () => {
  const forbiddenModuleTokens = [
    "firebase",
    "firestore",
    "pixi.js",
    "aul-world-runtime",
    "midtrans",
    "qris",
    "../persistence",
    "../cart",
  ];
  const requireCallPattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  const files = ["orderIntentTypes.js", "orderIntentAdapter.js"].map((f) => path.join(__dirname, f));
  const allowedTargets = new Set(["./orderIntentTypes", "../submission/submissionMachine"]);

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = requireCallPattern.exec(source)) !== null) {
      assert.equal(allowedTargets.has(match[1]), true, path.basename(file) + ' has an unexpected require("' + match[1] + '")');
    }
    for (const token of forbiddenModuleTokens) {
      assert.equal(
        source.toLowerCase().includes('require("' + token) || source.toLowerCase().includes("require('" + token),
        false,
        path.basename(file) + ' must not require anything referencing "' + token + '"'
      );
    }
    assert.equal(/document\.|window\./.test(source), false, path.basename(file) + " must not touch the DOM");
  }
});

// ============================================================
// I. BACKEND CONTRACT VERIFICATION (against the ACTUAL repo source)
// ============================================================

test("I30. actual callable name is 'orderIntent'", () => {
  const indexSource = fs.readFileSync(path.join(REPO_ROOT, "functions", "index.js"), "utf8");
  assert.match(indexSource, /orderIntent/);
  const harnessSource = fs.readFileSync(
    path.join(REPO_ROOT, "tools", "verification", "orderintent-auth-harness.html"),
    "utf8"
  );
  assert.match(harnessSource, /httpsCallable\(functions,\s*["']orderIntent["']\)/);
});

test("I31. request payload matches the ACTUAL backend-accepted fields", () => {
  const validationSource = fs.readFileSync(path.join(BACKEND_SRC, "services", "orderIntentInputValidation.js"), "utf8");
  const payload = buildOrderIntentRequestPayload({
    idempotencyKey: "abcdefgh12345678",
    items: [{ productId: "p1", quantity: 1, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
    customerName: "Budi",
    notes: null,
  });
  for (const key of Object.keys(payload)) {
    assert.equal(validationSource.includes(key), true, "backend validation source must mention field " + key);
  }
  for (const key of Object.keys(payload.items[0])) {
    assert.equal(validationSource.includes(key), true, "backend validation source must mention item field " + key);
  }
});

test("I32. authoritative result shape matches the ACTUAL backend projection fields", () => {
  const projectionSource = fs.readFileSync(path.join(BACKEND_SRC, "services", "orderIntentProjection.js"), "utf8");
  for (const key of ["orderState", "authoritativeTotal", "items", "customerName", "notes"]) {
    assert.equal(projectionSource.includes(key), true, "backend projection source must mention field " + key);
  }
  assert.equal(isValidAuthoritativeResultShape(validBackendResult()), true);
});

test("I33. error-code classification matches the ACTUAL codes thrown across the real request path", () => {
  // "invalid-argument" is thrown by orderIntentInputValidation.js,
  // "unauthenticated" by authGuard.js, and "failed-precondition"/
  // "internal" directly by orderIntent.js itself - all three files
  // participate in the one real request path this adapter calls into,
  // so all three are read here rather than assuming everything lives
  // in orderIntent.js alone.
  const combinedSource = [
    fs.readFileSync(path.join(BACKEND_SRC, "functions", "orderIntent.js"), "utf8"),
    fs.readFileSync(path.join(BACKEND_SRC, "services", "orderIntentInputValidation.js"), "utf8"),
    fs.readFileSync(path.join(BACKEND_SRC, "services", "authGuard.js"), "utf8"),
  ].join("\n");
  for (const code of PROVEN_NO_COMMIT_ERROR_CODES) {
    assert.equal(combinedSource.includes('"' + code + '"'), true, "the real request path must actually throw " + code);
  }
  // "internal" is deliberately NOT in PROVEN_NO_COMMIT_ERROR_CODES - the
  // backend's own comment does not guarantee it is pre-commit.
  const orderIntentSource = fs.readFileSync(path.join(BACKEND_SRC, "functions", "orderIntent.js"), "utf8");
  assert.equal(orderIntentSource.includes('"internal"'), true);
  assert.equal(PROVEN_NO_COMMIT_ERROR_CODES.includes("internal"), false);
});

// ============================================================
// Integration: the REAL persistence adapter (STEP 56), not the fake
// ============================================================

test("INTEGRATION: works end-to-end against the real kiosk/persistence adapter, not just the duck-typed fake", async () => {
  function createInMemoryStore() {
    const map = new Map();
    return {
      async get(key) { return map.has(key) ? map.get(key) : undefined; },
      async set(key, value) { map.set(key, value); },
      async delete(key) { map.delete(key); },
    };
  }

  const realPersistence = createPersistenceAdapter(createInMemoryStore());
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));

  const result = await submitNewAttempt(
    { ...validParams(), persistence: realPersistence, callOrderIntent: callable },
    fixedKeyDeps("abcdefgh12345678")
  );

  assert.equal(result.outcome, "SUCCEEDED");

  const loaded = await realPersistence.load("uid-A");
  assert.equal(loaded.status, "VALID");
  assert.equal(loaded.submissionAttempt, null); // removed on success
  assert.equal(loaded.authoritativeResult.idempotencyKey, "abcdefgh12345678");
});

test("INTEGRATION: UNKNOWN attempt round-trips correctly through the real persistence adapter", async () => {
  function createInMemoryStore() {
    const map = new Map();
    return {
      async get(key) { return map.has(key) ? map.get(key) : undefined; },
      async set(key, value) { map.set(key, value); },
      async delete(key) { map.delete(key); },
    };
  }

  const realPersistence = createPersistenceAdapter(createInMemoryStore());
  const failingCallable = createSpyCallable(async () => { throw { code: "unavailable" }; });

  const result = await submitNewAttempt(
    { ...validParams(), persistence: realPersistence, callOrderIntent: failingCallable },
    fixedKeyDeps("abcdefgh12345678")
  );
  assert.equal(result.outcome, "UNKNOWN");

  const loaded = await realPersistence.load("uid-A");
  assert.equal(loaded.status, "VALID");
  assert.equal(loaded.submissionAttempt.status, "UNKNOWN");
  assert.equal(loaded.submissionAttempt.idempotencyKey, "abcdefgh12345678");
});

// ============================================================
// CRITICAL: network ambiguity (STEP 58 S21)
// ============================================================

test("CRITICAL: response lost after backend success is UNKNOWN (never REJECTED), and same-key retry recovers", async () => {
  const persistence = createFakePersistence();
  const trueBackendData = validBackendResult(); // the "true" outcome, hidden from the adapter's view

  // Simulate: request dispatched, backend committed SUCCESS internally,
  // but the response is lost before the client sees it.
  const droppedResponseCallable = createSpyCallable(async () => {
    throw { message: "connection lost after dispatch" }; // no recognizable code
  });

  const result = await submitNewAttempt(
    { ...validParams(), persistence, callOrderIntent: droppedResponseCallable },
    fixedKeyDeps("abcdefgh12345678")
  );

  assert.equal(result.outcome, "UNKNOWN");
  assert.notEqual(result.outcome, "REJECTED");
  assert.equal(result.attempt.idempotencyKey, "abcdefgh12345678");

  const recoveringCallable = createSpyCallable(async (payload) => {
    assert.equal(payload.idempotencyKey, "abcdefgh12345678"); // same key used
    return { data: trueBackendData }; // simulates the backend's replay/recovery response
  });
  const retryResult = await retryUnknownAttempt({
    attempt: result.attempt,
    ownerUid: "uid-A",
    persistence,
    callOrderIntent: recoveringCallable,
  });

  assert.equal(retryResult.outcome, "SUCCEEDED");
  assert.equal(retryResult.attempt.idempotencyKey, "abcdefgh12345678");
});

// ============================================================
// Falsification block (STEP 58 S25) - one assertion per question
// ============================================================

test("Falsification F1: backend cannot be called before the pending attempt is persisted", async () => {
  const persistence = createFakePersistence({ async saveSubmissionAttempt() { return { ok: false, code: "X" }; } });
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(callable.calls.length, 0);
});

test("Falsification F2: persistence failure cannot result in a new key", async () => {
  let calls = 0;
  const deps = { generateKey: () => { calls += 1; return "abcdefgh12345678"; } };
  const persistence = createFakePersistence({ async saveSubmissionAttempt() { return { ok: false, code: "X" }; } });
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, deps);
  assert.equal(calls, 1);
});

test("Falsification F3: retry() cannot use a different key", async () => {
  const persistence = createFakePersistence();
  const failing = createSpyCallable(async () => { throw { code: "unavailable" }; });
  const first = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: failing }, fixedKeyDeps("keyoriginal12345"));
  const recovering = createSpyCallable(async () => ({ data: validBackendResult() }));
  await retryUnknownAttempt({ attempt: first.attempt, ownerUid: "uid-A", persistence, callOrderIntent: recovering });
  assert.equal(recovering.calls[0].idempotencyKey, "keyoriginal12345");
});

test("Falsification F4: retry cannot rebuild the request from the current Cart", async () => {
  const persistence = createFakePersistence();
  const original = validParams();
  const failing = createSpyCallable(async () => { throw { code: "unavailable" }; });
  const first = await submitNewAttempt({ ...original, persistence, callOrderIntent: failing }, fixedKeyDeps("abcdefgh12345678"));
  const recovering = createSpyCallable(async () => ({ data: validBackendResult() }));
  await retryUnknownAttempt({
    attempt: first.attempt,
    ownerUid: "uid-A",
    items: [{ productId: "TOTALLY_DIFFERENT", quantity: 1, selectedModifiers: [] }],
    persistence,
    callOrderIntent: recovering,
  });
  assert.deepEqual(recovering.calls[0].items, original.items);
});

test("Falsification F5: UNKNOWN cannot become REJECTED merely because a transport error occurred", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => { throw { message: "ECONNRESET" }; });
  const result = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.notEqual(result.outcome, "REJECTED");
  assert.equal(result.outcome, "UNKNOWN");
});

test("Falsification F6: UNKNOWN cannot be silently cleared", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => { throw { code: "unavailable" }; });
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.notEqual(persistence._state.submissionAttempt, null);
});

test("Falsification F7: UNKNOWN cannot trigger Auth Reset (no such capability exists)", () => {
  const source = fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8");
  assert.equal(/signout|rotateauth|authreset/i.test(source), false);
});

test("Falsification F8: a successful result cannot be fabricated locally", () => {
  const source =
    fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "orderIntentTypes.js"), "utf8");
  for (const forbidden of ["calculatetotal", "computetotal", "resolverecipe"]) {
    assert.equal(source.toLowerCase().includes(forbidden), false);
  }
});

test("Falsification F9: displaySnapshot cannot influence the backend request", () => {
  const payload = buildOrderIntentRequestPayload({
    idempotencyKey: "abcdefgh12345678",
    items: [{ productId: "p1", quantity: 1, selectedModifiers: [], displaySnapshot: { price: 999999999 } }],
    customerName: null,
    notes: null,
  });
  assert.equal(JSON.stringify(payload).includes("999999999"), false);
});

test("Falsification F10: authoritative price cannot be calculated locally", () => {
  const source = fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8");
  assert.equal(/\w+\s*\*\s*\w*price/i.test(source), false);
});

test("Falsification F11: adapter cannot call a payment provider (no such capability exists)", () => {
  const source =
    fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "orderIntentTypes.js"), "utf8");
  assert.equal(/midtrans|qris/i.test(source), false);
});

test("Falsification F12: adapter cannot call AWR/UI (no such capability exists)", () => {
  const source =
    fs.readFileSync(path.join(__dirname, "orderIntentAdapter.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "orderIntentTypes.js"), "utf8");
  assert.equal(/aul-world-runtime|pixi/i.test(source), false);
  assert.equal(/document\.|window\./.test(source), false);
});

test("Falsification F13: terminal SubmissionAttempt deletion cannot remove the Authoritative Result", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: validBackendResult() }));
  await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.equal(persistence._state.submissionAttempt, null);
  assert.notEqual(persistence._state.authoritativeResult, null);
});

test("Falsification F14: a malformed backend success response cannot be accepted as SUCCESS", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => ({ data: { orderState: "VALIDATED", items: "not-an-array" } }));
  const result = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.notEqual(result.outcome, "SUCCEEDED");
});

test("Falsification F15: a backend error with unknown commit status ('internal') cannot be classified REJECTED", async () => {
  const persistence = createFakePersistence();
  const callable = createSpyCallable(async () => {
    throw { code: "internal", message: "We couldn't process that order right now. Please try again." };
  });
  const result = await submitNewAttempt({ ...validParams(), persistence, callOrderIntent: callable }, fixedKeyDeps("abcdefgh12345678"));
  assert.notEqual(result.outcome, "REJECTED");
  assert.equal(result.outcome, "UNKNOWN");
});
