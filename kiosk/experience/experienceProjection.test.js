"use strict";

/**
 * Kiosk Experience projection tests (STEP 69).
 *
 * Run with: node --test kiosk/experience/experienceProjection.test.js
 * No new dependencies - Node's built-in test runner only. No Firebase,
 * no Firestore, no IndexedDB, no DOM, no real Runtime instance - every
 * input here is a plain object shaped like Runtime's own getSnapshot()/
 * submit()/retryUnknown() return values.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  projectExperienceSnapshot,
  projectOrderOutcomeFromActionResult,
  mapRejectionReason,
} = require("./experienceProjection");
const { SessionPhase, OrderStatus, RejectionCategory, DegradedCategory } = require("./experienceTypes");

// --- fixtures ---

function emptyCart() {
  return { lines: [], customerName: null, notes: null };
}

function cartWithOneLine(overrides) {
  return {
    lines: [
      Object.assign(
        {
          localLineId: "line_abc123",
          productId: "p1",
          quantity: 2,
          selectedModifiers: [{ groupId: "g1", optionId: "a" }],
          displaySnapshot: { name: "Kopi Susu", price: 15000, imageUrl: "x.png", categoryLabel: "Coffee" },
        },
        overrides
      ),
    ],
    customerName: "Budi",
    notes: "less ice",
  };
}

function submissionFixture(overrides) {
  return Object.assign(
    {
      idempotencyKey: "sub_fixture_0000001",
      items: [{ productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
      customerName: "Budi",
      notes: null,
      status: "IN_FLIGHT",
      committedAt: 1234567890,
      ownerUid: "uid-secret-owner-A",
      rejectionReason: undefined,
      unknownReason: undefined,
    },
    overrides
  );
}

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

function runtimeSnapshot(overrides) {
  return Object.assign(
    {
      cart: emptyCart(),
      submission: null,
      session: "IDLE",
      authoritativeResult: null,
      hydrated: true,
    },
    overrides
  );
}

// collects every key name found anywhere in a value, recursively
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

// collects every string value found anywhere, recursively
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
  "store",
  "callback",
  "callOrderIntent",
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
// A. Snapshot shape
// ============================================================

test("A1. ExperienceSnapshot has exactly the approved top-level keys", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot());
  assert.deepEqual(Object.keys(snapshot).sort(), ["capabilities", "cart", "degraded", "order", "ready", "session"]);
});

// ============================================================
// B. Session semantic mapping
// ============================================================

test("B1-B5. session phase mapping is deterministic and distinct from Runtime's own enum", () => {
  const table = [
    ["IDLE", SessionPhase.IDLE],
    ["ACTIVE", SessionPhase.ACTIVE],
    ["AWAITING_OUTCOME", SessionPhase.AWAITING_OUTCOME],
    ["CONFIRMATION", SessionPhase.CONFIRMATION],
    ["SOME_FUTURE_UNRECOGNIZED_STATE", SessionPhase.IDLE], // defensive fallback, never throws
  ];
  for (const [rawSession, expected] of table) {
    const snapshot = projectExperienceSnapshot(runtimeSnapshot({ session: rawSession }));
    assert.equal(snapshot.session, expected);
  }
});

test("B6. SessionPhase values are never byte-identical to Runtime's SessionStates values", () => {
  const runtimeValues = ["IDLE", "ACTIVE", "AWAITING_OUTCOME", "CONFIRMATION"];
  for (const phase of Object.values(SessionPhase)) {
    assert.equal(runtimeValues.includes(phase), false, "SessionPhase must not reuse a raw SessionStates string: " + phase);
  }
});

// ============================================================
// C. Cart projection
// ============================================================

test("C1. Cart lines project only customer-safe fields, dropping nothing required and adding nothing authoritative", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ cart: cartWithOneLine() }));
  assert.equal(snapshot.cart.lines.length, 1);
  const line = snapshot.cart.lines[0];
  assert.equal(line.lineRef, "line_abc123");
  assert.equal(line.productId, "p1");
  assert.equal(line.quantity, 2);
  assert.deepEqual(line.selectedModifiers, [{ groupId: "g1", optionId: "a" }]);
  assert.equal(line.displayName, "Kopi Susu");
  assert.equal(line.displayPrice, 15000);
  assert.equal(snapshot.cart.customerName, "Budi");
  assert.equal(snapshot.cart.notes, "less ice");
});

test("C2. empty Cart projects to an empty lines array, not null/undefined", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ cart: emptyCart() }));
  assert.deepEqual(snapshot.cart.lines, []);
});

// ============================================================
// D-H. Order status mapping
// ============================================================

test("D1. no submission and no result -> ORDER NONE", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot());
  assert.equal(snapshot.order.status, OrderStatus.NONE);
  assert.equal(snapshot.order.result, null);
  assert.equal(snapshot.order.rejectionCategory, null);
});

test("E1. submission IN_FLIGHT -> ORDER PENDING", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ submission: submissionFixture({ status: "IN_FLIGHT" }) }));
  assert.equal(snapshot.order.status, OrderStatus.PENDING);
  assert.equal(snapshot.order.result, null);
});

test("F1. submission UNKNOWN -> ORDER UNCERTAIN, no fake success result", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ submission: submissionFixture({ status: "UNKNOWN" }) }));
  assert.equal(snapshot.order.status, OrderStatus.UNCERTAIN);
  assert.equal(snapshot.order.result, null);
});

test("G1. authoritativeResult present, submission null -> ORDER CONFIRMED with the real result", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ authoritativeResult: authoritativeResultFixture() }));
  assert.equal(snapshot.order.status, OrderStatus.CONFIRMED);
  assert.equal(snapshot.order.result.authoritativeTotal, 30000);
  assert.equal(snapshot.order.result.items[0].productName, "Kopi Susu");
});

test("H1. REJECTED action result -> ORDER DECLINED via projectOrderOutcomeFromActionResult, never via the ongoing snapshot", () => {
  const declined = projectOrderOutcomeFromActionResult({
    outcome: "REJECTED",
    category: "VALIDATION_REJECTION",
    reason: "INSUFFICIENT_STOCK",
    attempt: null,
  });
  assert.equal(declined.status, OrderStatus.DECLINED);
  assert.equal(declined.rejectionCategory, RejectionCategory.QUANTITY_UNAVAILABLE);
  assert.equal(declined.result, null);

  // Confirm the ongoing snapshot itself (submission already cleared to
  // null by Runtime, exactly as it is post-REJECTED) shows NONE, not
  // DECLINED - DECLINED is transient-only under the actual Runtime contract.
  const snapshotAfter = projectExperienceSnapshot(runtimeSnapshot());
  assert.equal(snapshotAfter.order.status, OrderStatus.NONE);
});

test("H2. SUCCEEDED action result -> ORDER CONFIRMED with the real result", () => {
  const confirmed = projectOrderOutcomeFromActionResult({
    outcome: "SUCCEEDED",
    attempt: { authoritativeResult: authoritativeResultFixture() },
  });
  assert.equal(confirmed.status, OrderStatus.CONFIRMED);
  assert.equal(confirmed.result.authoritativeTotal, 30000);
});

test("H3. UNKNOWN action result -> ORDER UNCERTAIN", () => {
  const uncertain = projectOrderOutcomeFromActionResult({ outcome: "UNKNOWN", category: "TRANSPORT_UNKNOWN", attempt: submissionFixture({ status: "UNKNOWN" }) });
  assert.equal(uncertain.status, OrderStatus.UNCERTAIN);
});

test("H4. BLOCKED action result reflects the real in-memory attempt status rather than fabricating NONE", () => {
  const blockedInFlight = projectOrderOutcomeFromActionResult({
    outcome: "BLOCKED",
    category: "PERSISTENCE_FAILED",
    attempt: submissionFixture({ status: "IN_FLIGHT" }),
  });
  assert.equal(blockedInFlight.status, OrderStatus.PENDING);

  const blockedNoAttempt = projectOrderOutcomeFromActionResult({
    outcome: "BLOCKED",
    category: "CANNOT_BEGIN",
    attempt: null,
  });
  assert.equal(blockedNoAttempt.status, OrderStatus.NONE);
});

// ============================================================
// I. Rejection mapping (table-driven, actual current backend vocabulary)
// ============================================================

test("I1-I9. rejection code mapping matches the approved semantic table", () => {
  const table = [
    ["PRODUCT_UNAVAILABLE", RejectionCategory.ITEM_UNAVAILABLE],
    ["MODIFIER_GROUP_UNAVAILABLE", RejectionCategory.MODIFIER_UNAVAILABLE],
    ["MODIFIER_OPTION_UNAVAILABLE", RejectionCategory.MODIFIER_UNAVAILABLE],
    ["REQUIRED_MODIFIER_MISSING", RejectionCategory.SELECTION_INCOMPLETE],
    ["INSUFFICIENT_STOCK", RejectionCategory.QUANTITY_UNAVAILABLE],
    ["IDEMPOTENCY_KEY_CONFLICT", RejectionCategory.DUPLICATE_OR_CONFLICT],
    ["AUTH_REQUIRED", RejectionCategory.AUTH_REQUIRED],
    ["INVALID_REQUEST_SHAPE", RejectionCategory.REQUEST_INVALID],
    ["UNSPECIFIED_BUSINESS_REJECTION", RejectionCategory.GENERAL_REJECTION],
  ];
  for (const [raw, expected] of table) {
    assert.equal(mapRejectionReason(raw), expected, "mapping for " + raw);
  }
});

test("I10. an unrecognized future backend code safely falls back to GENERAL_REJECTION, never undefined", () => {
  assert.equal(mapRejectionReason("SOME_FUTURE_BACKEND_CODE_NOT_YET_MAPPED"), RejectionCategory.GENERAL_REJECTION);
  assert.equal(mapRejectionReason(undefined), RejectionCategory.GENERAL_REJECTION);
});

// ============================================================
// J/K. Forbidden fields (top-level and nested)
// ============================================================

test("J1. ExperienceSnapshot never exposes identity/internal fields even when the raw submission carries them", () => {
  const snapshot = projectExperienceSnapshot(
    runtimeSnapshot({ submission: submissionFixture({ status: "UNKNOWN", rejectionReason: "INSUFFICIENT_STOCK" }) })
  );
  assertNoForbiddenKeys(snapshot, "J1 snapshot (UNKNOWN)");
  assertNoForbiddenStringValues(snapshot, "J1 snapshot (UNKNOWN)");
});

test("J2. ExperienceSnapshot never exposes identity/internal fields when CONFIRMED", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ authoritativeResult: authoritativeResultFixture() }));
  assertNoForbiddenKeys(snapshot, "J2 snapshot (CONFIRMED)");
});

test("K1. DECLINED action-result projection never leaks the raw rejection code or attempt internals", () => {
  const declined = projectOrderOutcomeFromActionResult({
    outcome: "REJECTED",
    category: "VALIDATION_REJECTION",
    reason: "PRODUCT_UNAVAILABLE",
    attempt: submissionFixture({ status: "REJECTED", rejectionReason: "PRODUCT_UNAVAILABLE" }),
  });
  assertNoForbiddenKeys(declined, "K1 declined result");
  assertNoForbiddenStringValues(declined, "K1 declined result");
  assert.equal(declined.rejectionCategory, RejectionCategory.ITEM_UNAVAILABLE);
});

test("K2. nested authoritativeResult items/modifiers carry only the documented safe fields", () => {
  const snapshot = projectExperienceSnapshot(
    runtimeSnapshot({
      authoritativeResult: authoritativeResultFixture({
        items: [
          {
            productId: "p1",
            productName: "Kopi Susu",
            quantity: 1,
            unitPrice: 15000,
            lineTotal: 15000,
            selectedModifiers: [{ groupName: "Size", optionName: "Large", price: 0 }],
            // simulate a hypothetical future extra field that must NOT survive projection
            avgCost: 4000,
            hpp: 4200,
          },
        ],
      }),
    })
  );
  const item = snapshot.order.result.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["lineTotal", "productId", "productName", "quantity", "selectedModifiers", "unitPrice"]);
});

// ============================================================
// L. Immutability / no shared mutable reference
// ============================================================

test("L1. mutating the original runtime snapshot after projection does not affect the returned ExperienceSnapshot", () => {
  const rawCart = cartWithOneLine();
  const original = runtimeSnapshot({ cart: rawCart });
  const snapshot = projectExperienceSnapshot(original);

  rawCart.lines[0].quantity = 999;
  rawCart.lines.push({ localLineId: "line_new", productId: "p2", quantity: 1, selectedModifiers: [], displaySnapshot: {} });
  rawCart.customerName = "Someone Else";

  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(snapshot.cart.lines[0].quantity, 2);
  assert.equal(snapshot.cart.customerName, "Budi");
});

test("L2. the returned ExperienceSnapshot is frozen and cannot be mutated in place", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot({ cart: cartWithOneLine() }));
  assert.throws(() => {
    "use strict";
    snapshot.cart.lines[0].quantity = 1;
  }, TypeError);
  assert.throws(() => {
    "use strict";
    snapshot.ready = false;
  }, TypeError);
});

// ============================================================
// M. Capability derivation
// ============================================================

test("M1-M5. capabilities mirror Runtime's own guards exactly", () => {
  const cases = [
    { cart: emptyCart(), submission: null, expect: { canSubmit: false, canRetryUnknown: false, canRequestSessionEnd: true } },
    { cart: cartWithOneLine(), submission: null, expect: { canSubmit: true, canRetryUnknown: false, canRequestSessionEnd: true } },
    { cart: cartWithOneLine(), submission: submissionFixture({ status: "IN_FLIGHT" }), expect: { canSubmit: false, canRetryUnknown: false, canRequestSessionEnd: false } },
    { cart: cartWithOneLine(), submission: submissionFixture({ status: "UNKNOWN" }), expect: { canSubmit: false, canRetryUnknown: true, canRequestSessionEnd: false } },
  ];
  for (const c of cases) {
    const snapshot = projectExperienceSnapshot(runtimeSnapshot({ cart: c.cart, submission: c.submission }));
    assert.deepEqual(snapshot.capabilities, c.expect);
  }
});

// ============================================================
// N. Hydration / ready behavior
// ============================================================

test("N1. hydrated=false -> ready=false; hydrated=true -> ready=true", () => {
  assert.equal(projectExperienceSnapshot(runtimeSnapshot({ hydrated: false })).ready, false);
  assert.equal(projectExperienceSnapshot(runtimeSnapshot({ hydrated: true })).ready, true);
});

// ============================================================
// O. Degraded / anomaly sanitization
// ============================================================

test("O1. coexisting submission + authoritativeResult (hydration anomaly) yields a minimal DEGRADED signal, never raw records", () => {
  const snapshot = projectExperienceSnapshot(
    runtimeSnapshot({
      submission: submissionFixture({ status: "UNKNOWN", idempotencyKey: "key-attempt-0001" }),
      authoritativeResult: authoritativeResultFixture(),
    })
  );
  assert.deepEqual(snapshot.degraded, { category: DegradedCategory.NEEDS_ATTENTION });
  assertNoForbiddenKeys(snapshot, "O1 anomaly snapshot");
  assertNoForbiddenStringValues(snapshot, "O1 anomaly snapshot");
});

test("O2. ordinary operation (no coexistence) never reports degraded", () => {
  assert.equal(projectExperienceSnapshot(runtimeSnapshot()).degraded, null);
  assert.equal(projectExperienceSnapshot(runtimeSnapshot({ submission: submissionFixture({ status: "UNKNOWN" }) })).degraded, null);
  assert.equal(projectExperienceSnapshot(runtimeSnapshot({ authoritativeResult: authoritativeResultFixture() })).degraded, null);
});

// ============================================================
// P. Stale result handling
// ============================================================

test("P1. anomalous coexistence never surfaces the stale result as CONFIRMED", () => {
  const snapshot = projectExperienceSnapshot(
    runtimeSnapshot({
      submission: submissionFixture({ status: "UNKNOWN" }),
      authoritativeResult: authoritativeResultFixture(),
    })
  );
  assert.equal(snapshot.order.status, OrderStatus.UNCERTAIN);
  assert.equal(snapshot.order.result, null);
});

test("P2. a fresh NONE snapshot carries no leftover result", () => {
  const snapshot = projectExperienceSnapshot(runtimeSnapshot());
  assert.equal(snapshot.order.result, null);
});

// ============================================================
// Q. No second-state-machine / dependency boundary
// ============================================================

test("Q1/R1. experienceProjection.js and experienceTypes.js require nothing from kiosk/* Runtime modules or any I/O capability", () => {
  for (const file of ["experienceProjection.js", "experienceTypes.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const target of requireTargets) {
      assert.ok(
        target === "./experienceTypes",
        file + ": unexpected require target (must not depend on Runtime/Cart/Submission/Persistence/OrderIntent/Session): " + target
      );
    }
  }
});

test("R2. no actual Firebase/Firestore/IndexedDB/network API usage (only require() targets are checked - prose mentioning these words in doc comments is expected and fine)", () => {
  for (const file of ["experienceProjection.js", "experienceTypes.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const forbiddenUsage of [
      "require(\"firebase",
      "require('firebase",
      "indexedDB.",
      "httpsCallable(",
      "fetch(",
      "XMLHttpRequest",
      "setTimeout(",
      "setInterval(",
      "document.",
      "window.",
    ]) {
      assert.equal(source.includes(forbiddenUsage), false, file + ": must not actually use " + forbiddenUsage);
    }
  }
});

test("Q2. no global mutable module-level state is held between calls (repeated calls with equal input produce equal, independent output)", () => {
  const inputA = runtimeSnapshot({ cart: cartWithOneLine() });
  const snapshot1 = projectExperienceSnapshot(inputA);
  const snapshot2 = projectExperienceSnapshot(runtimeSnapshot({ cart: cartWithOneLine() }));
  assert.deepEqual(snapshot1, snapshot2);
  assert.notEqual(snapshot1, snapshot2); // distinct objects, not a cached singleton
});

// ============================================================
// S. Deterministic projection
// ============================================================

test("S1. equivalent but distinct inputs produce deep-equal output", () => {
  const s1 = projectExperienceSnapshot(runtimeSnapshot({ cart: cartWithOneLine(), submission: submissionFixture({ status: "UNKNOWN" }) }));
  const s2 = projectExperienceSnapshot(runtimeSnapshot({ cart: cartWithOneLine(), submission: submissionFixture({ status: "UNKNOWN" }) }));
  assert.deepEqual(s1, s2);
});

test("S2. missing/undefined runtime snapshot fields never throw", () => {
  assert.doesNotThrow(() => projectExperienceSnapshot({}));
  assert.doesNotThrow(() => projectExperienceSnapshot(undefined));
});
