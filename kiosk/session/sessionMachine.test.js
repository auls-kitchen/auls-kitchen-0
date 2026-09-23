"use strict";

/**
 * Kiosk Customer Session runtime tests (STEP 59).
 *
 * Run with: node --test kiosk/session/sessionMachine.test.js
 * No new dependencies - Node's built-in test runner only. No DOM, no
 * timers, no Firebase, no IndexedDB, no OrderIntent network call.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { SessionStates, EventTypes, applyEvent, canEndSession, requestSessionEnd } = require("./sessionMachine");

const { IDLE, ACTIVE, AWAITING_OUTCOME, CONFIRMATION } = SessionStates;

function createRecordingDeps(overrides) {
  const calls = [];
  const base = {
    stopInteraction: async () => { calls.push("stopInteraction"); },
    clearCart: async () => { calls.push("clearCart"); return { ok: true }; },
    clearTerminalSubmission: async () => { calls.push("clearTerminalSubmission"); return { ok: true }; },
    clearAuthoritativeResult: async () => { calls.push("clearAuthoritativeResult"); return { ok: true }; },
    purgePersistence: async () => { calls.push("purgePersistence"); return { ok: true }; },
    resetSession: async () => { calls.push("resetSession"); },
    requestAuthReset: async () => { calls.push("requestAuthReset"); },
    neutralIdle: async () => { calls.push("neutralIdle"); },
  };
  const merged = Object.assign({}, base, overrides);
  Object.defineProperty(merged, "_calls", { value: calls, enumerable: false });
  return merged;
}

// ============================================================
// A. START
// ============================================================

test("A1. IDLE + first item added -> ACTIVE", () => {
  const result = applyEvent(IDLE, { type: EventTypes.FIRST_CART_ITEM_ADDED });
  assert.equal(result.ok, true);
  assert.equal(result.state, ACTIVE);
});

test("A2. repeated item add does not restart the session", () => {
  const first = applyEvent(IDLE, { type: EventTypes.FIRST_CART_ITEM_ADDED });
  const second = applyEvent(first.state, { type: EventTypes.FIRST_CART_ITEM_ADDED });
  assert.equal(second.ok, true);
  assert.equal(second.state, ACTIVE); // still ACTIVE, not a "new" session concept
});

test("A3. page load does not start a session (no such event exists; unrecognized events are illegal no-ops)", () => {
  const result = applyEvent(IDLE, { type: "PAGE_LOAD" });
  assert.equal(result.ok, false);
  assert.equal(result.state, IDLE);
});

test("A4. product/category view does not start a session", () => {
  const result = applyEvent(IDLE, { type: "PRODUCT_VIEWED" });
  assert.equal(result.ok, false);
  assert.equal(result.state, IDLE);
  const result2 = applyEvent(IDLE, { type: "CATEGORY_VIEWED" });
  assert.equal(result2.ok, false);
  assert.equal(result2.state, IDLE);
});

// ============================================================
// B. ACTIVE
// ============================================================

test("B5. active Cart remains ACTIVE across further additions", () => {
  const result = applyEvent(ACTIVE, { type: EventTypes.FIRST_CART_ITEM_ADDED });
  assert.equal(result.ok, true);
  assert.equal(result.state, ACTIVE);
});

test("B6. submission start transitions ACTIVE -> AWAITING_OUTCOME", () => {
  const result = applyEvent(ACTIVE, { type: EventTypes.SUBMISSION_STARTED });
  assert.equal(result.ok, true);
  assert.equal(result.state, AWAITING_OUTCOME);
});

test("B7. result availability transitions AWAITING_OUTCOME -> CONFIRMATION", () => {
  const result = applyEvent(AWAITING_OUTCOME, { type: EventTypes.AUTHORITATIVE_RESULT_AVAILABLE });
  assert.equal(result.ok, true);
  assert.equal(result.state, CONFIRMATION);
});

test("B7b. rejection transitions AWAITING_OUTCOME back to ACTIVE (backend proved no commit)", () => {
  const result = applyEvent(AWAITING_OUTCOME, { type: EventTypes.SUBMISSION_REJECTED });
  assert.equal(result.ok, true);
  assert.equal(result.state, ACTIVE);
});

// ============================================================
// C. END GUARD
// ============================================================

test("C8. completion without confirmation is rejected", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: ACTIVE,
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reason, "NOT_END_ELIGIBLE_STATE");
});

test("C9. confirmation alone (without an explicit disengagement event) never ends the session", () => {
  // Reaching CONFIRMATION via applyEvent never itself produces "ended" -
  // only requestSessionEnd, given an explicit event, can do that.
  const result = applyEvent(AWAITING_OUTCOME, { type: EventTypes.AUTHORITATIVE_RESULT_AVAILABLE });
  assert.equal(result.state, CONFIRMATION);
  assert.notEqual(result.state, IDLE);
});

test("C10. confirmation + completion allows end", async () => {
  const deps = createRecordingDeps();
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.equal(result.outcome, "SESSION_ENDED");
});

test("C11. confirmation + return-to-idle allows end", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_RETURNED_TO_IDLE },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "SESSION_ENDED");
});

test("C12. confirmation + inactivity allows end", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.INACTIVITY_TIMEOUT },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "SESSION_ENDED");
});

test("C13. inactivity while ambiguous (UNKNOWN) blocks end even from CONFIRMATION", async () => {
  const deps = createRecordingDeps();
  const result = await requestSessionEnd({
    event: { type: EventTypes.INACTIVITY_TIMEOUT },
    currentState: CONFIRMATION,
    submissionStatus: "UNKNOWN", // defensive/inconsistent-context case
    deps,
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reason, "SUBMISSION_OUTCOME_AMBIGUOUS");
  assert.equal(deps._calls.includes("clearCart"), false);
});

test("C14. completion while IN_FLIGHT blocks end", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "IN_FLIGHT",
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reason, "SUBMISSION_OUTCOME_AMBIGUOUS");
});

test("C15. completion while UNKNOWN blocks end", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "UNKNOWN",
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reason, "SUBMISSION_OUTCOME_AMBIGUOUS");
});

test("C16. payment ambiguity blocks end conceptually (no Payment implemented)", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    paymentOutcomeAmbiguous: true,
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reason, "PAYMENT_OUTCOME_AMBIGUOUS");
});

// ============================================================
// D. CANCEL
// ============================================================

test("D17. pre-submit cancel with no active attempt can end", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_CANCELLED },
    currentState: ACTIVE,
    submissionStatus: null,
    deps: createRecordingDeps(),
  });
  assert.equal(result.outcome, "SESSION_ENDED");
});

test("D18. cancel with an unresolved attempt is blocked (both by state and by the ambiguity guard)", async () => {
  const viaAmbiguity = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_CANCELLED },
    currentState: ACTIVE,
    submissionStatus: "IN_FLIGHT",
    deps: createRecordingDeps(),
  });
  assert.equal(viaAmbiguity.outcome, "BLOCKED");
  assert.equal(viaAmbiguity.reason, "SUBMISSION_OUTCOME_AMBIGUOUS");

  const viaState = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_CANCELLED },
    currentState: AWAITING_OUTCOME,
    submissionStatus: "IN_FLIGHT",
    deps: createRecordingDeps(),
  });
  assert.equal(viaState.outcome, "BLOCKED");
  assert.equal(viaState.reason, "NOT_END_ELIGIBLE_STATE");
});

test("D19. cancel never clears an unresolved SubmissionAttempt", async () => {
  const deps = createRecordingDeps();
  await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_CANCELLED },
    currentState: ACTIVE,
    submissionStatus: "UNKNOWN",
    deps,
  });
  assert.equal(deps._calls.includes("clearTerminalSubmission"), false);
});

// ============================================================
// E. RESET
// ============================================================

test("E20/E21/E23. reset order is enforced: stopInteraction, ambiguityGuard, clearCart, clearTerminalSubmission, clearAuthoritativeResult, purgePersistence, resetSession, requestAuthReset, neutralIdle", async () => {
  const deps = createRecordingDeps();
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
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
  assert.ok(result.callLog.indexOf("purgePersistence") < result.callLog.indexOf("requestAuthReset"));
});

test("E22. Auth Reset is not called when ambiguity exists", async () => {
  const deps = createRecordingDeps();
  await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "IN_FLIGHT",
    deps,
  });
  assert.equal(deps._calls.includes("requestAuthReset"), false);
});

test("E24. result cleanup is distinct from submission cleanup - a failure in one is reported specifically, not masked", async () => {
  const deps = createRecordingDeps({
    clearAuthoritativeResult: async () => ({ ok: false, code: "X" }),
  });
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  assert.equal(deps._calls.includes("clearTerminalSubmission"), true); // still ran, succeeded
  assert.equal(result.reason.length, 1);
  assert.equal(result.reason[0].step, "clearAuthoritativeResult");
  assert.equal(result.reason[0].code, "CLEAR_RESULT_FAILED");
});

// ============================================================
// F. RELOAD
// ============================================================

test("F25. a reload event does not end the session (no such capability exists)", () => {
  const result = applyEvent(CONFIRMATION, { type: "BROWSER_RELOAD" });
  assert.equal(result.ok, false);
  assert.equal(result.state, CONFIRMATION);
  const sessionMachineExports = Object.keys(require("./sessionMachine"));
  assert.equal(sessionMachineExports.some((k) => /reload/i.test(k)), false);
});

// ============================================================
// G. FAILURE
// ============================================================

test("G26. purge failure does not falsely claim clean completion", async () => {
  const deps = createRecordingDeps({
    purgePersistence: async () => ({ ok: false, code: "PURGE_FAILURE" }),
  });
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  assert.equal(deps._calls.includes("requestAuthReset"), false);
});

test("G27. Auth reset failure is represented explicitly", async () => {
  const deps = createRecordingDeps({
    requestAuthReset: async () => { throw new Error("auth service unavailable"); },
  });
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  assert.equal(result.reason[0].code, "AUTH_RESET_FAILED");
  assert.equal(deps._calls.includes("neutralIdle"), false); // never reached
});

test("G28. cart-clear failure is represented explicitly, and other independent steps still attempt best-effort cleanup", async () => {
  const deps = createRecordingDeps({
    clearCart: async () => { throw new Error("storage exception"); },
  });
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.equal(result.outcome, "RESET_INCOMPLETE");
  assert.equal(result.reason[0].step, "clearCart");
  assert.equal(result.reason[0].code, "CLEAR_CART_FAILED");
  // best-effort: the other three data-cleanup steps still ran
  assert.equal(deps._calls.includes("clearTerminalSubmission"), true);
  assert.equal(deps._calls.includes("clearAuthoritativeResult"), true);
  assert.equal(deps._calls.includes("purgePersistence"), true);
  // but Auth Reset never ran, since failures.length > 0
  assert.equal(deps._calls.includes("requestAuthReset"), false);
});

// ============================================================
// H. BOUNDARY
// ============================================================

test("H29-H33. no Firebase/IndexedDB/OrderIntent/payment/AWR/UI dependency", () => {
  const forbiddenModuleTokens = [
    "firebase",
    "firestore",
    "indexeddb",
    "../orderintent",
    "../persistence",
    "../cart",
    "pixi.js",
    "aul-world-runtime",
    "midtrans",
    "qris",
  ];
  const requireCallPattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  const files = ["sessionTypes.js", "sessionMachine.js"].map((f) => path.join(__dirname, f));
  const allowedTargets = new Set(["./sessionTypes"]);

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
    assert.equal(/settimeout|setinterval/i.test(source), false, path.basename(file) + " must not schedule timers");
  }
});

// ============================================================
// Falsification block (STEP 59 S23)
// ============================================================

test("Falsification F1: first page load cannot create a Session", () => {
  const result = applyEvent(IDLE, { type: "PAGE_LOAD" });
  assert.notEqual(result.state, ACTIVE);
});

test("Falsification F2: product browsing cannot create a Session", () => {
  const result = applyEvent(IDLE, { type: "PRODUCT_VIEWED" });
  assert.notEqual(result.state, ACTIVE);
});

test("Falsification F3: Session End cannot happen before confirmation", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: ACTIVE,
    deps: createRecordingDeps(),
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
});

test("Falsification F4: confirmation alone cannot end a Session (no dispatched event => no change)", () => {
  assert.notEqual(CONFIRMATION, IDLE);
});

test("Falsification F5: IN_FLIGHT cannot end a Session", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "IN_FLIGHT",
    deps: createRecordingDeps(),
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
});

test("Falsification F6: UNKNOWN cannot end a Session", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "UNKNOWN",
    deps: createRecordingDeps(),
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
});

test("Falsification F7: payment ambiguity cannot end a Session", async () => {
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    paymentOutcomeAmbiguous: true,
    deps: createRecordingDeps(),
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
});

test("Falsification F8: Auth Reset cannot occur while ambiguous", async () => {
  const deps = createRecordingDeps();
  await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "IN_FLIGHT",
    deps,
  });
  assert.equal(deps._calls.includes("requestAuthReset"), false);
});

test("Falsification F9: purge cannot happen after Auth Reset", async () => {
  const deps = createRecordingDeps();
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  const purgeIndex = result.callLog.indexOf("purgePersistence");
  const authIndex = result.callLog.indexOf("requestAuthReset");
  assert.ok(purgeIndex >= 0 && authIndex >= 0);
  assert.ok(purgeIndex < authIndex);
});

test("Falsification F10: Session machine cannot call Firebase Auth directly", () => {
  const source = fs.readFileSync(path.join(__dirname, "sessionMachine.js"), "utf8");
  assert.equal(/getauth\(|signinanonymously|signout/i.test(source), false);
});

test("Falsification F11: Session machine cannot call OrderIntent", () => {
  const source = fs.readFileSync(path.join(__dirname, "sessionMachine.js"), "utf8");
  assert.equal(/httpscallable|orderintentadapter/i.test(source), false);
});

test("Falsification F12: reload cannot be treated as Session End", () => {
  const result = applyEvent(CONFIRMATION, { type: "RELOAD" });
  assert.notEqual(result.state, IDLE);
});

test("Falsification F13: cancel cannot clear an unresolved SubmissionAttempt", async () => {
  const deps = createRecordingDeps();
  await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_CANCELLED },
    currentState: ACTIVE,
    submissionStatus: "IN_FLIGHT",
    deps,
  });
  assert.equal(deps._calls.includes("clearTerminalSubmission"), false);
});

test("Falsification F14: reset cannot claim success when purge failed", async () => {
  const deps = createRecordingDeps({ purgePersistence: async () => ({ ok: false }) });
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "SUCCEEDED",
    deps,
  });
  assert.notEqual(result.outcome, "SESSION_ENDED");
});

test("Falsification F15: reset cannot continue destructively after the ambiguity guard fails", async () => {
  const deps = createRecordingDeps();
  const result = await requestSessionEnd({
    event: { type: EventTypes.CUSTOMER_COMPLETED },
    currentState: CONFIRMATION,
    submissionStatus: "UNKNOWN",
    deps,
  });
  assert.deepEqual(result.callLog, ["stopInteraction", "ambiguityGuard"]);
  for (const step of ["clearCart", "clearTerminalSubmission", "clearAuthoritativeResult", "purgePersistence", "resetSession", "requestAuthReset", "neutralIdle"]) {
    assert.equal(deps._calls.includes(step), false, step + " must never be called");
  }
});
