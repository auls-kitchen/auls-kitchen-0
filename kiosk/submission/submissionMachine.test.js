"use strict";

/**
 * Kiosk Submission Attempt state machine tests (STEP 57).
 *
 * Run with: node --test kiosk/submission/submissionMachine.test.js
 * No new dependencies - Node's built-in test runner only.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  beginSubmission,
  markSuccess,
  markRejected,
  markUnknown,
  retry,
  clearTerminalAttempt,
} = require("./submissionMachine");
const { IDEMPOTENCY_KEY_PATTERN, defaultGenerateIdempotencyKey } = require("./submissionTypes");

function validInput(overrides) {
  return Object.assign(
    {
      items: [{ productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
      customerName: "Budi",
      notes: "less ice",
      ownerUid: "uid-A",
    },
    overrides
  );
}

function fixedKey(key) {
  return { generateKey: () => key };
}

function beginFixed(key, overrides) {
  const result = beginSubmission(null, validInput(overrides), fixedKey(key));
  assert.equal(result.ok, true, "fixture setup must succeed");
  return result.attempt;
}

// ============================================================
// A. Creation
// ============================================================

test("A1. IDLE -> beginSubmission -> IN_FLIGHT", () => {
  const result = beginSubmission(null, validInput(), fixedKey("abcdefgh12345678"));
  assert.equal(result.ok, true);
  assert.equal(result.attempt.status, "IN_FLIGHT");
});

test("A2. a key is generated exactly once per beginSubmission call", () => {
  let calls = 0;
  const deps = {
    generateKey: () => {
      calls += 1;
      return "abcdefgh12345678";
    },
  };
  beginSubmission(null, validInput(), deps);
  assert.equal(calls, 1);
});

test("A3. generated key matches the accepted idempotencyKey format", () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(IDEMPOTENCY_KEY_PATTERN.test(defaultGenerateIdempotencyKey()), true);
  }
  const result = beginSubmission(null, validInput());
  assert.equal(IDEMPOTENCY_KEY_PATTERN.test(result.attempt.idempotencyKey), true);
});

test("A4. snapshot contains the correct items", () => {
  const attempt = beginFixed("abcdefgh12345678");
  assert.deepEqual(attempt.items, [
    { productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] },
  ]);
});

test("A5. snapshot contains customerName/notes", () => {
  const attempt = beginFixed("abcdefgh12345678");
  assert.equal(attempt.customerName, "Budi");
  assert.equal(attempt.notes, "less ice");
});

test("A6. attempt content is immutable", () => {
  const attempt = beginFixed("abcdefgh12345678");
  assert.throws(() => {
    attempt.customerName = "Someone Else";
  });
  assert.throws(() => {
    attempt.items.push({ productId: "p2", quantity: 1, selectedModifiers: [] });
  });
  assert.throws(() => {
    attempt.items[0].quantity = 999;
  });
});

test("A7. beginSubmission is illegal while an attempt is already active", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const result = beginSubmission(attempt, validInput(), fixedKey("zzzzzzzz99999999"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "ILLEGAL_TRANSITION");
  assert.equal(result.state, attempt);
});

// ============================================================
// B. UNKNOWN + retry
// ============================================================

test("B8. IN_FLIGHT -> UNKNOWN", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const result = markUnknown(attempt, "network timeout");
  assert.equal(result.ok, true);
  assert.equal(result.attempt.status, "UNKNOWN");
});

test("B9. UNKNOWN preserves the exact key", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  assert.equal(unknownAttempt.idempotencyKey, "abcdefgh12345678");
});

test("B10. UNKNOWN preserves the exact submitted content", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  assert.deepEqual(unknownAttempt.items, attempt.items);
  assert.equal(unknownAttempt.customerName, attempt.customerName);
  assert.equal(unknownAttempt.notes, attempt.notes);
});

test("B11. UNKNOWN is not REJECTED", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  assert.notEqual(unknownAttempt.status, "REJECTED");
});

test("B12. UNKNOWN is not IDLE (state is not null)", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  assert.notEqual(unknownAttempt, null);
});

test("B13. UNKNOWN -> retry -> IN_FLIGHT", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  const result = retry(unknownAttempt);
  assert.equal(result.ok, true);
  assert.equal(result.attempt.status, "IN_FLIGHT");
});

test("B14. retry preserves the exact same key", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  const { attempt: retried } = retry(unknownAttempt);
  assert.equal(retried.idempotencyKey, "abcdefgh12345678");
});

test("B15. retry preserves the exact same submitted content", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  const { attempt: retried } = retry(unknownAttempt);
  assert.deepEqual(retried.items, attempt.items);
  assert.equal(retried.customerName, attempt.customerName);
  assert.equal(retried.notes, attempt.notes);
  assert.equal(retried.committedAt, attempt.committedAt);
});

test("B16. retry never generates a second key", () => {
  let generateCalls = 0;
  const deps = { generateKey: () => { generateCalls += 1; return "abcdefgh12345678"; } };
  const { attempt } = beginSubmission(null, validInput(), deps);
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  retry(unknownAttempt);
  assert.equal(generateCalls, 1, "retry must not invoke key generation at all");
});

// ============================================================
// C. SUCCESS
// ============================================================

test("C17. IN_FLIGHT -> SUCCEEDED", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const result = markSuccess(attempt, { orderState: "VALIDATED", authoritativeTotal: 30000 });
  assert.equal(result.ok, true);
  assert.equal(result.attempt.status, "SUCCEEDED");
});

test("C18. authoritative result is attached, not fabricated", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const suppliedResult = { orderState: "VALIDATED", authoritativeTotal: 30000, items: [] };
  const { attempt: succeeded } = markSuccess(attempt, suppliedResult);
  assert.deepEqual(succeeded.authoritativeResult, suppliedResult);
});

test("C19. success does not change the key", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: succeeded } = markSuccess(attempt, { orderState: "VALIDATED" });
  assert.equal(succeeded.idempotencyKey, "abcdefgh12345678");
});

test("C20. SUCCEEDED cannot retry", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: succeeded } = markSuccess(attempt, { orderState: "VALIDATED" });
  const result = retry(succeeded);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ILLEGAL_TRANSITION");
  assert.equal(result.state, succeeded);
});

test("C21. SUCCEEDED cannot mutate submitted content (and cannot be marked SUCCEEDED again)", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: succeeded } = markSuccess(attempt, { orderState: "VALIDATED" });
  assert.throws(() => {
    succeeded.items = [];
  });
  const secondMarkSuccess = markSuccess(succeeded, { orderState: "VALIDATED_AGAIN" });
  assert.equal(secondMarkSuccess.ok, false);
  assert.equal(secondMarkSuccess.code, "ILLEGAL_TRANSITION");
});

// ============================================================
// D. REJECTION
// ============================================================

test("D22. IN_FLIGHT -> REJECTED", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const result = markRejected(attempt, "INSUFFICIENT_STOCK");
  assert.equal(result.ok, true);
  assert.equal(result.attempt.status, "REJECTED");
});

test("D23. rejection reason is retained", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: rejected } = markRejected(attempt, "INSUFFICIENT_STOCK");
  assert.equal(rejected.rejectionReason, "INSUFFICIENT_STOCK");
});

test("D24. REJECTED cannot retry as the same attempt", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: rejected } = markRejected(attempt, "INSUFFICIENT_STOCK");
  const result = retry(rejected);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ILLEGAL_TRANSITION");
  assert.equal(result.state, rejected);
});

test("D25. no automatic new key: a fresh submission after clearing gets a genuinely NEW key, never a silent reuse", () => {
  const attempt = beginFixed("keyoriginal12345");
  const { attempt: rejected } = markRejected(attempt, "INSUFFICIENT_STOCK");
  const { attempt: cleared } = clearTerminalAttempt(rejected);
  assert.equal(cleared, null);

  const { attempt: newAttempt } = beginSubmission(cleared, validInput(), fixedKey("keybrandnew67890"));
  assert.notEqual(newAttempt.idempotencyKey, rejected.idempotencyKey);
});

// ============================================================
// E. Illegal transitions (comprehensive)
// ============================================================

test("E26. all listed illegal transitions are rejected deterministically, state unchanged", () => {
  const inFlight = beginFixed("abcdefgh12345678");
  const { attempt: succeeded } = markSuccess(beginFixed("succkey123456789"), { orderState: "VALIDATED" });
  const { attempt: rejected } = markRejected(beginFixed("rejkey1234567890"), "reason");
  const { attempt: unknownAttempt } = markUnknown(beginFixed("unkkey1234567890"), "timeout");

  const cases = [
    ["IDLE -> retry", () => retry(null)],
    ["IDLE -> markSuccess", () => markSuccess(null, {})],
    ["IDLE -> markRejected", () => markRejected(null, "x")],
    ["IDLE -> markUnknown", () => markUnknown(null, "x")],
    ["SUCCEEDED -> retry", () => retry(succeeded)],
    ["SUCCEEDED -> markUnknown", () => markUnknown(succeeded, "x")],
    ["SUCCEEDED -> markSuccess again", () => markSuccess(succeeded, {})],
    ["SUCCEEDED -> markRejected", () => markRejected(succeeded, "x")],
    ["REJECTED -> retry", () => retry(rejected)],
    ["REJECTED -> markSuccess", () => markSuccess(rejected, {})],
    ["REJECTED -> markUnknown", () => markUnknown(rejected, "x")],
    ["REJECTED -> markRejected again", () => markRejected(rejected, "y")],
    ["UNKNOWN -> markSuccess (must retry to IN_FLIGHT first)", () => markSuccess(unknownAttempt, {})],
    ["UNKNOWN -> markRejected (must retry to IN_FLIGHT first)", () => markRejected(unknownAttempt, "x")],
    ["IN_FLIGHT -> retry (retry is only legal from UNKNOWN)", () => retry(inFlight)],
  ];

  for (const [label, run] of cases) {
    const result = run();
    assert.equal(result.ok, false, label + " must be illegal");
    assert.equal(result.code, "ILLEGAL_TRANSITION", label + " must report ILLEGAL_TRANSITION");
  }
});

test("E27. illegal transitions leave the prior state reference exactly unchanged", () => {
  const succeeded = markSuccess(beginFixed("abcdefgh12345678"), {}).attempt;
  const illegalResult = markUnknown(succeeded, "x");
  assert.equal(illegalResult.ok, false);
  assert.equal(illegalResult.state, succeeded); // exact reference equality, not a copy

  const rejected = markRejected(beginFixed("rejkey1234567890"), "reason").attempt;
  const illegalResult2 = retry(rejected);
  assert.equal(illegalResult2.ok, false);
  assert.equal(illegalResult2.state, rejected);
});

// ============================================================
// F. Cart boundary
// ============================================================

test("F28. later mutation of the caller's own input cannot mutate the attempt snapshot", () => {
  const items = [{ productId: "p1", quantity: 1, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }];
  const input = { items, customerName: "Budi", notes: null, ownerUid: "uid-A" };
  const { attempt } = beginSubmission(null, input, fixedKey("abcdefgh12345678"));

  // Mutate the ORIGINAL objects after the fact.
  items[0].quantity = 999;
  items.push({ productId: "p2", quantity: 5, selectedModifiers: [] });
  input.customerName = "Someone Else";

  assert.equal(attempt.items.length, 1);
  assert.equal(attempt.items[0].quantity, 1);
  assert.equal(attempt.customerName, "Budi");
});

test("F29. attempt snapshot never contains Cart UI-only state (localLineId/displaySnapshot)", () => {
  const attempt = beginFixed("abcdefgh12345678");
  for (const item of attempt.items) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, "localLineId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item, "displaySnapshot"), false);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "localLineId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "displaySnapshot"), false);
});

// ============================================================
// G. Dependency boundary
// ============================================================

test("G30-33. no Firebase/persistence/OrderIntent/AWR/payment dependency", () => {
  const forbiddenModuleTokens = [
    "firebase",
    "firestore",
    "orderintent",
    "pixi.js",
    "aul-world-runtime",
    "midtrans",
    "qris",
    "../persistence",
    "../cart",
  ];
  const requireCallPattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  const files = ["submissionTypes.js", "submissionMachine.js"].map((f) => path.join(__dirname, f));
  const allowedTargets = new Set(["./submissionTypes"]);

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = requireCallPattern.exec(source)) !== null) {
      assert.equal(
        allowedTargets.has(match[1]),
        true,
        path.basename(file) + ' has an unexpected require("' + match[1] + '")'
      );
    }
    for (const token of forbiddenModuleTokens) {
      assert.equal(
        source.toLowerCase().includes('require("' + token) || source.toLowerCase().includes("require('" + token),
        false,
        path.basename(file) + ' must not require anything referencing "' + token + '"'
      );
    }
    assert.equal(/httpscallable/i.test(source), false, path.basename(file) + " must not call httpsCallable");
    assert.equal(/fetch\(/i.test(source), false, path.basename(file) + " must not perform a network fetch");
    assert.equal(/settimeout|setinterval/i.test(source), false, path.basename(file) + " must not schedule timers");
  }
});

// ============================================================
// H. Safety
// ============================================================

test("H34. no UNKNOWN -> new key path exists anywhere in the public API", () => {
  const submissionMachine = require("./submissionMachine");
  assert.deepEqual(
    Object.keys(submissionMachine).sort(),
    ["beginSubmission", "clearTerminalAttempt", "markRejected", "markSuccess", "markUnknown", "retry"].sort()
  );
});

test("H35. a successful key can never end up attached to different content", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const { attempt: succeeded } = markSuccess(attempt, { orderState: "VALIDATED" });
  // Every mutator is illegal against a terminal SUCCEEDED state - the
  // ONLY legal operation is clearTerminalAttempt (which discards it
  // entirely, never edits it in place).
  assert.equal(markSuccess(succeeded, {}).ok, false);
  assert.equal(markRejected(succeeded, "x").ok, false);
  assert.equal(markUnknown(succeeded, "x").ok, false);
  assert.equal(retry(succeeded).ok, false);
  const cleared = clearTerminalAttempt(succeeded);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.attempt, null); // discarded, never edited
});

test("H36. a persistence-write failure can be represented as 'submission blocked' without generating a replacement key", () => {
  // No persistence dependency exists in this module (proven above), so
  // this demonstrates the STRUCTURAL guarantee a future caller relies
  // on: once an attempt is IN_FLIGHT (e.g. immediately after a
  // persistence write was attempted, successfully or not), beginSubmission
  // is illegal - there is no way to react to "persistence write failed"
  // by generating a second, replacement key while the first is still
  // active.
  const attempt = beginFixed("abcdefgh12345678");
  // Simulate: the caller attempted to persist `attempt` and it failed.
  // The only structurally available reaction is to leave `attempt` as
  // the current state and refuse further submission attempts.
  const reactionResult = beginSubmission(attempt, validInput(), fixedKey("shouldneverbeused"));
  assert.equal(reactionResult.ok, false);
  assert.equal(reactionResult.code, "ILLEGAL_TRANSITION");
  assert.equal(reactionResult.state, attempt); // the original, still-pending attempt is preserved intact
});

// ============================================================
// Explicit falsification block (STEP 57 S21) - one assertion per
// question, for direct traceability in the test report.
// ============================================================

test("Falsification F1: UNKNOWN cannot generate a new key", () => {
  const attempt = beginFixed("origkey123456789");
  const { attempt: unknownAttempt } = markUnknown(attempt, "timeout");
  const { attempt: retried } = retry(unknownAttempt);
  assert.equal(retried.idempotencyKey, "origkey123456789");
});

test("Falsification F2: retry() cannot change the key", () => {
  const attempt = beginFixed("origkey123456789");
  const { attempt: unknownAttempt } = markUnknown(attempt, "x");
  const { attempt: retried } = retry(unknownAttempt);
  assert.equal(retried.idempotencyKey, attempt.idempotencyKey);
});

test("Falsification F3: Cart mutation after the fact cannot alter an existing attempt", () => {
  const items = [{ productId: "p1", quantity: 1, selectedModifiers: [] }];
  const { attempt } = beginSubmission(null, { items, customerName: null, notes: null }, fixedKey("abcdefgh12345678"));
  items[0].quantity = 42;
  assert.equal(attempt.items[0].quantity, 1);
});

test("Falsification F4: SUCCEEDED cannot retry", () => {
  const { attempt } = markSuccess(beginFixed("abcdefgh12345678"), {});
  assert.equal(retry(attempt).ok, false);
});

test("Falsification F5: REJECTED cannot silently auto-submit", () => {
  const { attempt } = markRejected(beginFixed("abcdefgh12345678"), "reason");
  assert.equal(retry(attempt).ok, false);
  assert.equal(markSuccess(attempt, {}).ok, false);
});

test("Falsification F6: UNKNOWN cannot silently become REJECTED", () => {
  const { attempt } = markUnknown(beginFixed("abcdefgh12345678"), "timeout");
  assert.equal(markRejected(attempt, "guessed").ok, false);
});

test("Falsification F7: UNKNOWN cannot silently become IDLE", () => {
  const { attempt } = markUnknown(beginFixed("abcdefgh12345678"), "timeout");
  assert.equal(clearTerminalAttempt(attempt).ok, false);
});

test("Falsification F8: a successful key cannot be attached to different content", () => {
  const { attempt } = markSuccess(beginFixed("abcdefgh12345678"), {});
  assert.equal(markSuccess(attempt, { different: true }).ok, false);
});

test("Falsification F9: the state machine cannot call OrderIntent (no such capability exists)", () => {
  const source = fs.readFileSync(path.join(__dirname, "submissionMachine.js"), "utf8");
  assert.equal(/httpscallable|getfunctions/i.test(source), false);
});

test("Falsification F10: the state machine cannot call Firebase (no such capability exists)", () => {
  const source = fs.readFileSync(path.join(__dirname, "submissionMachine.js"), "utf8");
  assert.equal(/require\(["']firebase/i.test(source), false);
});

test("Falsification F11: a persistence failure cannot force a new key", () => {
  const attempt = beginFixed("abcdefgh12345678");
  const result = beginSubmission(attempt, validInput(), fixedKey("differentkey0000"));
  assert.equal(result.ok, false);
});

test("Falsification F12: an authoritative result cannot be fabricated locally", () => {
  const source = fs.readFileSync(path.join(__dirname, "submissionMachine.js"), "utf8");
  // markSuccess must only ever attach what it receives - grep confirms
  // no computation of total/price/hpp/recipe/stock exists anywhere.
  for (const forbidden of ["calculateTotal", "computeTotal", "resolveRecipe", "hpp", "stock"]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, "must not compute " + forbidden);
  }
  const result = markSuccess(beginFixed("abcdefgh12345678"), undefined);
  assert.equal(result.ok, false); // cannot even proceed without a supplied result
});
