"use strict";

/**
 * Kiosk persistence adapter tests (STEP 56).
 *
 * Run with: node --test kiosk/persistence/persistenceAdapter.test.js
 * No new dependencies - Node's built-in test runner + a small
 * injectable in-memory store defined below, satisfying the exact same
 * {get,set,delete} contract the real IndexedDB adapter also implements.
 *
 * IMPORTANT: these tests exercise persistenceAdapter.js's domain logic
 * only. indexedDbAdapter.js (the real browser IndexedDB implementation)
 * is NOT exercised here - there is no browser runtime in this
 * environment. See the final report's "Browser/IndexedDB Verification
 * Boundary" section for what is and is not proven.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createPersistenceAdapter, STORAGE_KEY } = require("./persistenceAdapter");
const { ResultCodes, WriteErrorCodes } = require("./persistenceTypes");

// --- test-only injectable stores ---

function createInMemoryStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : undefined;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    _map: map, // test-only direct access, for corruption injection
  };
}

function createFailingStore(base, which) {
  return {
    get: which === "get" ? async () => { throw new Error("injected read failure"); } : base.get,
    set: which === "set" ? async () => { throw new Error("injected write failure"); } : base.set,
    delete:
      which === "delete" ? async () => { throw new Error("injected delete failure"); } : base.delete,
    _map: base._map,
  };
}

// --- fixtures ---

function validCartDraft() {
  return {
    lines: [
      {
        localLineId: "line_1",
        productId: "p1",
        quantity: 2,
        selectedModifiers: [{ groupId: "g1", optionId: "a" }],
        displaySnapshot: { name: "Kopi", price: 15000, extra: "anything" },
      },
    ],
    customerName: "Budi",
    notes: "less ice",
  };
}

function validSubmissionAttempt(overrides) {
  return Object.assign(
    {
      idempotencyKey: "abcdefgh12345678",
      items: [{ productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
      customerName: "Budi",
      notes: null,
      status: "IN_FLIGHT",
      committedAt: 1700000000000,
    },
    overrides
  );
}

function validAuthoritativeResult() {
  return {
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
  };
}

// ============================================================
// A. Cart Draft
// ============================================================

test("A1. save/load valid Cart Draft", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const saveResult = await adapter.saveCartDraft("uid-A", validCartDraft());
  assert.equal(saveResult.ok, true);

  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.VALID);
  assert.equal(loaded.cartDraft.lines.length, 1);
  assert.equal(loaded.cartDraft.customerName, "Budi");
});

test("A2. empty state", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.EMPTY);
});

test("A3. displaySnapshot is preserved as opaque data", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const draft = validCartDraft();
  draft.lines[0].displaySnapshot = { name: "Kopi", price: 999999, weirdField: { nested: true } };
  await adapter.saveCartDraft("uid-A", draft);
  const loaded = await adapter.load("uid-A");
  assert.deepEqual(loaded.cartDraft.lines[0].displaySnapshot, draft.lines[0].displaySnapshot);
});

test("A4. no authoritative price calculation anywhere in the envelope", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  const loaded = await adapter.load("uid-A");
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.cartDraft, "total"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.cartDraft, "authoritativeTotal"), false);
});

test("A5. malformed Cart Draft is rejected", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const bad1 = await adapter.saveCartDraft("uid-A", { lines: "not-an-array", customerName: null, notes: null });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.code, WriteErrorCodes.VALIDATION_FAILURE);

  const draftWithBadQuantity = validCartDraft();
  draftWithBadQuantity.lines[0].quantity = 0;
  const bad2 = await adapter.saveCartDraft("uid-A", draftWithBadQuantity);
  assert.equal(bad2.ok, false);
  assert.equal(bad2.code, WriteErrorCodes.VALIDATION_FAILURE);
});

// ============================================================
// B. Submission Attempt
// ============================================================

test("B6. save/load IN_FLIGHT attempt", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const result = await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ status: "IN_FLIGHT" }));
  assert.equal(result.ok, true);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.submissionAttempt.status, "IN_FLIGHT");
});

test("B7. save/load UNKNOWN attempt", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ status: "UNKNOWN" }));
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.submissionAttempt.status, "UNKNOWN");
});

test("B8. same idempotencyKey preserved exactly across save/load", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const key = "myOwnKeySupplied1";
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ idempotencyKey: key }));
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.submissionAttempt.idempotencyKey, key);
});

test("B9. persistence never generates an idempotencyKey itself", () => {
  const files = ["persistenceTypes.js", "persistenceAdapter.js", "indexedDbAdapter.js"].map((f) =>
    path.join(__dirname, f)
  );
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes("Math.random"), false, path.basename(file) + " must not generate random values");
    assert.equal(/uuid/i.test(source), false, path.basename(file) + " must not reference uuid generation");
  }
});

test("B10. malformed Submission Attempt is rejected", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const result = await adapter.saveSubmissionAttempt(
    "uid-A",
    validSubmissionAttempt({ items: "not-an-array" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, WriteErrorCodes.VALIDATION_FAILURE);
});

test("B11. invalid status is rejected (terminal statuses may never be saved)", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  for (const status of ["SUCCEEDED", "REJECTED", "IDLE", "SOMETHING_ELSE"]) {
    const result = await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ status }));
    assert.equal(result.ok, false, "status=" + status + " must be rejected");
    assert.equal(result.code, WriteErrorCodes.VALIDATION_FAILURE);
  }
});

test("B12. missing/malformed idempotencyKey is rejected", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const noKey = await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ idempotencyKey: "" }));
  assert.equal(noKey.ok, false);
  const badFormat = await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ idempotencyKey: "short" }));
  assert.equal(badFormat.ok, false);
});

// ============================================================
// C. Authoritative Result
// ============================================================

test("C13. save/load Authoritative Result", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const result = await adapter.saveAuthoritativeResult("uid-A", "abcdefgh12345678", validAuthoritativeResult());
  assert.equal(result.ok, true);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.authoritativeResult.orderState, "VALIDATED");
  assert.equal(loaded.authoritativeResult.idempotencyKey, "abcdefgh12345678");
});

test("C14. Authoritative Result survives Submission Attempt removal", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt());
  await adapter.saveAuthoritativeResult("uid-A", "abcdefgh12345678", validAuthoritativeResult());
  await adapter.removeSubmissionAttempt("uid-A");

  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.submissionAttempt, null);
  assert.notEqual(loaded.authoritativeResult, null);
});

test("C15. Authoritative Result can be explicitly deleted independently", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  await adapter.saveAuthoritativeResult("uid-A", "abcdefgh12345678", validAuthoritativeResult());
  await adapter.removeAuthoritativeResult("uid-A");

  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.authoritativeResult, null);
  assert.notEqual(loaded.cartDraft, null);
});

// ============================================================
// D. Identity isolation
// ============================================================

test("D16. matching UID hydrates", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.VALID);
});

test("D17. mismatched UID does not hydrate", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  const loaded = await adapter.load("uid-B");
  assert.equal(loaded.status, ResultCodes.UID_MISMATCH);
});

test("D18. mismatch never leaks any domain data", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt());
  await adapter.saveAuthoritativeResult("uid-A", "abcdefgh12345678", validAuthoritativeResult());

  const loaded = await adapter.load("uid-B");
  assert.equal(loaded.status, ResultCodes.UID_MISMATCH);
  assert.equal(loaded.cartDraft, undefined);
  assert.equal(loaded.submissionAttempt, undefined);
  assert.equal(loaded.authoritativeResult, undefined);
});

// ============================================================
// E. Expiry
// ============================================================

test("E19. fresh state is not reported expired", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  const loaded = await adapter.load("uid-A", { cartDraftMaxAgeMs: 10 * 60 * 1000 });
  assert.equal(loaded.cartDraftExpired, false);
});

test("E20. expired Cart Draft is detectable without being discarded", async () => {
  const store = createInMemoryStore();
  const adapter = createPersistenceAdapter(store);
  await adapter.saveCartDraft("uid-A", validCartDraft());
  // backdate the record directly, bypassing the adapter (test-only)
  const raw = store._map.get(STORAGE_KEY);
  raw.cartDraft.writtenAt = Date.now() - 1_000_000;
  store._map.set(STORAGE_KEY, raw);

  const loaded = await adapter.load("uid-A", { cartDraftMaxAgeMs: 1000 });
  assert.equal(loaded.cartDraftExpired, true);
  assert.notEqual(loaded.cartDraft, null); // still returned, not discarded
});

test("E21. expired Authoritative Result is detectable", async () => {
  const store = createInMemoryStore();
  const adapter = createPersistenceAdapter(store);
  await adapter.saveAuthoritativeResult("uid-A", "abcdefgh12345678", validAuthoritativeResult());
  const raw = store._map.get(STORAGE_KEY);
  raw.authoritativeResult.writtenAt = Date.now() - 1_000_000;
  store._map.set(STORAGE_KEY, raw);

  const loaded = await adapter.load("uid-A", { authoritativeResultMaxAgeMs: 1000 });
  assert.equal(loaded.authoritativeResultExpired, true);
});

test("E22. an expired UNRESOLVED Submission Attempt remains distinguishable from resolution (never auto-resolved)", async () => {
  const store = createInMemoryStore();
  const adapter = createPersistenceAdapter(store);
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt({ status: "UNKNOWN" }));
  const raw = store._map.get(STORAGE_KEY);
  raw.submissionAttempt.writtenAt = Date.now() - 1_000_000;
  store._map.set(STORAGE_KEY, raw);

  const loaded = await adapter.load("uid-A", { submissionAttemptMaxAgeMs: 1000 });
  assert.equal(loaded.submissionAttemptExpired, true);
  // Critical: expiry is informational ONLY - status must remain exactly
  // what it was, never silently reinterpreted as SUCCEEDED/REJECTED.
  assert.equal(loaded.submissionAttempt.status, "UNKNOWN");
  assert.equal(loaded.submissionAttempt.idempotencyKey, "abcdefgh12345678");
});

// ============================================================
// F. Storage failure
// ============================================================

test("F23. READ_FAILURE is distinct from EMPTY", async () => {
  const base = createInMemoryStore();
  const adapter = createPersistenceAdapter(createFailingStore(base, "get"));
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.READ_FAILURE);
  assert.notEqual(loaded.status, ResultCodes.EMPTY);
});

test("F24. WRITE_FAILURE is distinct from success", async () => {
  const base = createInMemoryStore();
  const adapter = createPersistenceAdapter(createFailingStore(base, "set"));
  const result = await adapter.saveCartDraft("uid-A", validCartDraft());
  assert.equal(result.ok, false);
  assert.equal(result.code, WriteErrorCodes.WRITE_FAILURE);
});

test("F25. DELETE/PURGE_FAILURE is distinct from success", async () => {
  const base = createInMemoryStore();
  const adapter = createPersistenceAdapter(createFailingStore(base, "delete"));
  const result = await adapter.purgeCustomerContext();
  assert.equal(result.ok, false);
  assert.equal(result.code, WriteErrorCodes.DELETE_FAILURE);
});

test("F25b. a read failure during save never silently drops an existing unresolved attempt", async () => {
  const base = createInMemoryStore();
  await base.set(STORAGE_KEY, {
    schemaVersion: 1,
    ownerUidAtWrite: "uid-A",
    writtenAt: Date.now(),
    cartDraft: null,
    submissionAttempt: { ...validSubmissionAttempt(), writtenAt: Date.now() },
    authoritativeResult: null,
  });
  const adapter = createPersistenceAdapter(createFailingStore(base, "get"));
  const result = await adapter.saveCartDraft("uid-A", validCartDraft());
  assert.equal(result.ok, false);
  assert.equal(result.code, WriteErrorCodes.WRITE_FAILURE);
});

// ============================================================
// G. Corruption / schema
// ============================================================

test("G26. missing schemaVersion is CORRUPT_RECORD", async () => {
  const store = createInMemoryStore();
  await store.set(STORAGE_KEY, { ownerUidAtWrite: "uid-A", writtenAt: Date.now() });
  const adapter = createPersistenceAdapter(store);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.CORRUPT_RECORD);
});

test("G27. unsupported schemaVersion is UNSUPPORTED_SCHEMA", async () => {
  const store = createInMemoryStore();
  await store.set(STORAGE_KEY, { schemaVersion: 999, ownerUidAtWrite: "uid-A", writtenAt: Date.now() });
  const adapter = createPersistenceAdapter(store);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.UNSUPPORTED_SCHEMA);
  assert.equal(loaded.foundSchemaVersion, 999);
});

test("G28. malformed root record is CORRUPT_RECORD", async () => {
  const store = createInMemoryStore();
  await store.set(STORAGE_KEY, "this is not an object");
  const adapter = createPersistenceAdapter(store);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.CORRUPT_RECORD);
});

test("G29. malformed nested data is CORRUPT_RECORD", async () => {
  const store = createInMemoryStore();
  await store.set(STORAGE_KEY, {
    schemaVersion: 1,
    ownerUidAtWrite: "uid-A",
    writtenAt: Date.now(),
    cartDraft: { lines: "not-an-array", customerName: null, notes: null },
    submissionAttempt: null,
    authoritativeResult: null,
  });
  const adapter = createPersistenceAdapter(store);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.CORRUPT_RECORD);
});

test("G29b. malformed record is never partially repaired or guessed at", async () => {
  const store = createInMemoryStore();
  await store.set(STORAGE_KEY, {
    schemaVersion: 1,
    ownerUidAtWrite: "uid-A",
    writtenAt: Date.now(),
    cartDraft: { lines: [{ localLineId: "l1", productId: "p1", quantity: -5, selectedModifiers: [], displaySnapshot: {} }], customerName: null, notes: null },
    submissionAttempt: null,
    authoritativeResult: null,
  });
  const adapter = createPersistenceAdapter(store);
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.CORRUPT_RECORD);
  assert.equal(loaded.cartDraft, undefined); // no partial/guessed data returned
});

// ============================================================
// H. Purge
// ============================================================

test("H30. purge removes the entire customer context", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  await adapter.saveCartDraft("uid-A", validCartDraft());
  await adapter.saveSubmissionAttempt("uid-A", validSubmissionAttempt());
  const purgeResult = await adapter.purgeCustomerContext();
  assert.equal(purgeResult.ok, true);

  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.status, ResultCodes.EMPTY);
});

test("H31. purge performs no Auth-related operation (source-level guarantee)", () => {
  const source = fs.readFileSync(path.join(__dirname, "persistenceAdapter.js"), "utf8");
  const startIdx = source.indexOf("async function purgeCustomerContext");
  const endIdx = source.indexOf("\n  return {\n    saveCartDraft,");
  const purgeFn = source.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 400);
  // Deliberately specific tokens, not a bare "auth" substring, since
  // "authoritativeResult"/"AuthoritativeResult" legitimately contains
  // that substring elsewhere in this same file and must not be a false
  // positive here.
  const authRelatedTokens = ["signout", "signin", "rotateauth", "authreset", "firebaseauth", "getauth("];
  const lower = purgeFn.toLowerCase();
  for (const token of authRelatedTokens) {
    assert.equal(lower.includes(token), false, "purgeCustomerContext must not reference " + token);
  }
});

test("H32. purge takes no session-validity parameter and always executes unconditionally", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  // purgeCustomerContext() accepts zero arguments in this contract -
  // there is no "isSessionEndValid" or similar gate to pass.
  assert.equal(adapter.purgeCustomerContext.length, 0);
  const result = await adapter.purgeCustomerContext(); // succeeds even with nothing persisted
  assert.equal(result.ok, true);
});

// ============================================================
// I. Isolation boundary
// ============================================================

test("I33-36. adapter imports no Firebase/AWR/payment provider and never calls OrderIntent", () => {
  const forbiddenModuleTokens = [
    "firebase",
    "firestore",
    "orderintent",
    "pixi.js",
    "aul-world-runtime",
    "midtrans",
    "qris",
  ];
  const requireCallPattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  const files = ["persistenceTypes.js", "persistenceAdapter.js", "indexedDbAdapter.js"].map((f) =>
    path.join(__dirname, f)
  );
  const allowedTargets = new Set(["./persistenceTypes", "./persistenceAdapter"]);

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = requireCallPattern.exec(source)) !== null) {
      const target = match[1].toLowerCase();
      assert.equal(
        allowedTargets.has(match[1]),
        true,
        path.basename(file) + ' has an unexpected require("' + match[1] + '")'
      );
      for (const token of forbiddenModuleTokens) {
        assert.equal(target.includes(token), false, path.basename(file) + ' must not require "' + token + '"');
      }
    }
    // No source in this surface may call a Cloud Functions "httpsCallable"
    // style API. (A prose mention of "OrderIntent" in a documentation
    // comment explaining the boundary - as this file's own header does -
    // is legitimate and must not be flagged; the require-target scan
    // above is the actually meaningful import-boundary check.)
    assert.equal(/httpscallable/i.test(source), false, path.basename(file) + " must not call httpsCallable");
  }
});

// ============================================================
// Write-ahead sequence (STEP 56 S7 / S21) - proves the adapter CAN
// safely support write-ahead-before-network-call, without implementing
// the Submission layer or calling OrderIntent itself.
// ============================================================

test("write-ahead: a pending attempt can be durably persisted before any network call would occur", async () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  // Step 1: (future layer) generates a key - NOT done here, supplied by
  // the caller, exactly as the locked contract requires.
  const suppliedKey = "callerSuppliedKey1";
  // Step 2: construct the immutable SubmissionAttempt.
  const attempt = validSubmissionAttempt({ idempotencyKey: suppliedKey, status: "IN_FLIGHT" });
  // Step 3: persist BEFORE any network call would fire.
  const saveResult = await adapter.saveSubmissionAttempt("uid-A", attempt);
  assert.equal(saveResult.ok, true);
  // Step 4: only now would a real Submission layer call OrderIntent -
  // not implemented here, per scope. We confirm the durable record is
  // present and intact, ready to be retried with the SAME key if the
  // (unimplemented) network call's outcome turns out to be unknown.
  const loaded = await adapter.load("uid-A");
  assert.equal(loaded.submissionAttempt.idempotencyKey, suppliedKey);
  assert.equal(loaded.submissionAttempt.status, "IN_FLIGHT");
});

test("UNKNOWN never transitions to a fresh key inside this layer (no such operation exists)", () => {
  const adapter = createPersistenceAdapter(createInMemoryStore());
  const publicMethods = Object.keys(adapter);
  // The adapter's entire public surface is listed here - there is no
  // "generateNewKey", "regenerateAttempt", or similar operation.
  assert.deepEqual(
    publicMethods.sort(),
    [
      "load",
      "purgeCustomerContext",
      "removeAuthoritativeResult",
      "removeSubmissionAttempt",
      "saveAuthoritativeResult",
      "saveCartDraft",
      "saveSubmissionAttempt",
    ].sort()
  );
});
