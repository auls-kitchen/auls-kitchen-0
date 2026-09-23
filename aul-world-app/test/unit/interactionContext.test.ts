// U1 targeted tests for src/experience/interactionContext.ts.
// Covers brief section 16 items A (timing) and B (input reset), the
// approved boot state / transient CONTEXT_EXPIRED decisions, and the
// "timer is not customer input" rule. Run with: npm test (node --test).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THRESHOLDS,
  assertValidThresholds,
  createInitialInteractionState,
  phaseForSilence,
  reduceInteraction,
} from "../../src/experience/interactionContext.ts";
import type {
  InteractionPhase,
  InteractionState,
  InteractionThresholds,
} from "../../src/experience/interactionContext.ts";

// Monotonic-style base deliberately non-zero and fractional: the reducer must
// work on differences, never on absolute values.
const T0 = 1_234_567.5;

function input(state: InteractionState, at: number, thresholds?: InteractionThresholds) {
  return reduceInteraction(state, { type: "CUSTOMER_INPUT", at }, thresholds);
}

function evaluate(state: InteractionState, at: number, thresholds?: InteractionThresholds) {
  return reduceInteraction(state, { type: "EVALUATE", at }, thresholds);
}

// ============================================================
// Boot state and thresholds
// ============================================================

test("Z1. boot state is HABITAT_IDLE with no recorded input", () => {
  const state = createInitialInteractionState();
  assert.equal(state.phase, "HABITAT_IDLE");
  assert.equal(state.lastInputAt, null);
});

test("Z2. default thresholds are 15s / 25s / 5min", () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { spaceGivenMs: 15_000, releasedMs: 25_000, contextExpiredMs: 300_000 });
});

test("Z3. HABITAT_IDLE is never left by a timer: EVALUATE at any time changes nothing", () => {
  const boot = createInitialInteractionState();
  for (const at of [0, 15_000, 25_000, 300_000, 10_000_000]) {
    const result = evaluate(boot, at);
    assert.equal(result.state, boot, `EVALUATE at ${at} must return the same state`);
    assert.deepEqual(result.transitions, []);
  }
});

// ============================================================
// A. Experience timing
// ============================================================

test("A1. 0s: first customer input enters ACTIVE_STANDBY from HABITAT_IDLE", () => {
  const result = input(createInitialInteractionState(), T0);
  assert.equal(result.state.phase, "ACTIVE_STANDBY");
  assert.equal(result.state.lastInputAt, T0);
  assert.deepEqual(result.transitions, ["ACTIVE_STANDBY"]);
});

test("A2. silence just under 15s stays ACTIVE_STANDBY", () => {
  const active = input(createInitialInteractionState(), T0).state;
  const result = evaluate(active, T0 + 14_999);
  assert.equal(result.state.phase, "ACTIVE_STANDBY");
  assert.deepEqual(result.transitions, []);
});

test("A3. ~15s of silence -> SPACE_GIVEN", () => {
  const active = input(createInitialInteractionState(), T0).state;
  const result = evaluate(active, T0 + 15_000);
  assert.equal(result.state.phase, "SPACE_GIVEN");
  assert.equal(result.state.lastInputAt, T0);
  assert.deepEqual(result.transitions, ["SPACE_GIVEN"]);
});

test("A4. ~25s of total silence -> RELEASED", () => {
  const spaceGiven = evaluate(input(createInitialInteractionState(), T0).state, T0 + 15_000).state;
  const justBefore = evaluate(spaceGiven, T0 + 24_999);
  assert.equal(justBefore.state.phase, "SPACE_GIVEN");
  assert.deepEqual(justBefore.transitions, []);

  const released = evaluate(spaceGiven, T0 + 25_000);
  assert.equal(released.state.phase, "RELEASED");
  assert.deepEqual(released.transitions, ["RELEASED"]);
});

test("A5. ~5min of total silence -> CONTEXT_EXPIRED then HABITAT_IDLE, resting in HABITAT_IDLE", () => {
  const released = evaluate(evaluate(input(createInitialInteractionState(), T0).state, T0 + 15_000).state, T0 + 25_000).state;
  const justBefore = evaluate(released, T0 + 299_999);
  assert.equal(justBefore.state.phase, "RELEASED");
  assert.deepEqual(justBefore.transitions, []);

  const expired = evaluate(released, T0 + 300_000);
  assert.equal(expired.state.phase, "HABITAT_IDLE");
  assert.equal(expired.state.lastInputAt, null);
  assert.deepEqual(expired.transitions, ["CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

test("A6. full timeline reports each phase exactly once, in order", () => {
  let state = createInitialInteractionState();
  const seen: InteractionPhase[] = [];
  const apply = (step: { state: InteractionState; transitions: readonly InteractionPhase[] }) => {
    state = step.state;
    seen.push(...step.transitions);
  };

  apply(input(state, T0));
  for (const offset of [1_000, 14_999, 15_000, 20_000, 25_000, 100_000, 299_999, 300_000, 400_000]) {
    apply(evaluate(state, T0 + offset));
  }

  assert.deepEqual(seen, ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
  assert.equal(state.phase, "HABITAT_IDLE");
});

test("A7. catch-up: a single late EVALUATE reports every crossed phase in order", () => {
  const active = input(createInitialInteractionState(), T0).state;

  const toReleased = evaluate(active, T0 + 26_000);
  assert.equal(toReleased.state.phase, "RELEASED");
  assert.deepEqual(toReleased.transitions, ["SPACE_GIVEN", "RELEASED"]);

  const toHabitat = evaluate(active, T0 + 400_000);
  assert.equal(toHabitat.state.phase, "HABITAT_IDLE");
  assert.deepEqual(toHabitat.transitions, ["SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

test("A8. CONTEXT_EXPIRED is transient: no reachable state ever rests in it", () => {
  const active = input(createInitialInteractionState(), T0).state;
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 250) {
    const phase: string = evaluate(active, T0 + elapsed).state.phase;
    assert.notEqual(phase, "CONTEXT_EXPIRED", `state rested in CONTEXT_EXPIRED at +${elapsed}ms`);
  }
});

test("A9. EVALUATE is idempotent for a given time", () => {
  const active = input(createInitialInteractionState(), T0).state;
  const first = evaluate(active, T0 + 26_000);
  const second = evaluate(first.state, T0 + 26_000);
  assert.equal(second.state, first.state);
  assert.deepEqual(second.transitions, []);
});

test("A10. phaseForSilence maps elapsed silence with inclusive boundaries", () => {
  assert.equal(phaseForSilence(0), "ACTIVE_STANDBY");
  assert.equal(phaseForSilence(14_999.9), "ACTIVE_STANDBY");
  assert.equal(phaseForSilence(15_000), "SPACE_GIVEN");
  assert.equal(phaseForSilence(24_999), "SPACE_GIVEN");
  assert.equal(phaseForSilence(25_000), "RELEASED");
  assert.equal(phaseForSilence(299_999), "RELEASED");
  assert.equal(phaseForSilence(300_000), "CONTEXT_EXPIRED");
});

test("A11. custom (scaled) thresholds are honored", () => {
  const scaled: InteractionThresholds = { spaceGivenMs: 150, releasedMs: 250, contextExpiredMs: 3_000 };
  const active = input(createInitialInteractionState(), T0, scaled).state;
  assert.equal(evaluate(active, T0 + 149, scaled).state.phase, "ACTIVE_STANDBY");
  assert.equal(evaluate(active, T0 + 150, scaled).state.phase, "SPACE_GIVEN");
  assert.equal(evaluate(active, T0 + 250, scaled).state.phase, "RELEASED");
  assert.equal(evaluate(active, T0 + 3_000, scaled).state.phase, "HABITAT_IDLE");
});

test("A12. invalid thresholds are rejected", () => {
  assert.throws(() => assertValidThresholds({ spaceGivenMs: 0, releasedMs: 25, contextExpiredMs: 300 }), RangeError);
  assert.throws(() => assertValidThresholds({ spaceGivenMs: -1, releasedMs: 25, contextExpiredMs: 300 }), RangeError);
  assert.throws(() => assertValidThresholds({ spaceGivenMs: Number.NaN, releasedMs: 25, contextExpiredMs: 300 }), RangeError);
  assert.throws(() => assertValidThresholds({ spaceGivenMs: 25, releasedMs: 25, contextExpiredMs: 300 }), RangeError);
  assert.throws(() => assertValidThresholds({ spaceGivenMs: 30, releasedMs: 25, contextExpiredMs: 300 }), RangeError);
  assert.throws(() => assertValidThresholds({ spaceGivenMs: 15, releasedMs: 300, contextExpiredMs: 300 }), RangeError);
  assert.throws(
    () => reduceInteraction(createInitialInteractionState(), { type: "EVALUATE", at: 0 }, { spaceGivenMs: 5, releasedMs: 4, contextExpiredMs: 9 }),
    RangeError,
  );
});

// ============================================================
// B. Input reset
// ============================================================

test("B1. input during SPACE_GIVEN returns to ACTIVE_STANDBY and restarts the silence window", () => {
  const spaceGiven = evaluate(input(createInitialInteractionState(), T0).state, T0 + 16_000).state;
  const woken = input(spaceGiven, T0 + 20_000);
  assert.equal(woken.state.phase, "ACTIVE_STANDBY");
  assert.equal(woken.state.lastInputAt, T0 + 20_000);
  assert.deepEqual(woken.transitions, ["ACTIVE_STANDBY"]);

  // The 15s window now counts from the new input, not the original one.
  assert.equal(evaluate(woken.state, T0 + 20_000 + 14_999).state.phase, "ACTIVE_STANDBY");
  assert.equal(evaluate(woken.state, T0 + 20_000 + 15_000).state.phase, "SPACE_GIVEN");
});

test("B2. input during RELEASED returns to ACTIVE_STANDBY", () => {
  const released = evaluate(input(createInitialInteractionState(), T0).state, T0 + 100_000).state;
  assert.equal(released.phase, "RELEASED");
  const woken = input(released, T0 + 100_500);
  assert.equal(woken.state.phase, "ACTIVE_STANDBY");
  assert.deepEqual(woken.transitions, ["ACTIVE_STANDBY"]);
});

test("B3. input just before expiry prevents Habitat", () => {
  const released = evaluate(input(createInitialInteractionState(), T0).state, T0 + 100_000).state;
  const woken = input(released, T0 + 299_999);
  assert.equal(woken.state.phase, "ACTIVE_STANDBY");

  // 5 minutes after the ORIGINAL input would have expired; it must not, now.
  assert.equal(evaluate(woken.state, T0 + 300_000).state.phase, "ACTIVE_STANDBY");
  assert.equal(evaluate(woken.state, T0 + 299_999 + 299_999).state.phase, "RELEASED");
});

test("B4. repeated input while ACTIVE_STANDBY restarts the window but reports no transition", () => {
  const first = input(createInitialInteractionState(), T0).state;
  const second = input(first, T0 + 10_000);
  assert.equal(second.state.phase, "ACTIVE_STANDBY");
  assert.equal(second.state.lastInputAt, T0 + 10_000);
  assert.deepEqual(second.transitions, []);
  assert.equal(evaluate(second.state, T0 + 10_000 + 14_999).state.phase, "ACTIVE_STANDBY");
});

test("B5. input after Habitat wakes to ACTIVE_STANDBY (waking is reported as a transition)", () => {
  const habitat = evaluate(input(createInitialInteractionState(), T0).state, T0 + 300_000).state;
  assert.equal(habitat.phase, "HABITAT_IDLE");
  const woken = input(habitat, T0 + 900_000);
  assert.equal(woken.state.phase, "ACTIVE_STANDBY");
  assert.equal(woken.state.lastInputAt, T0 + 900_000);
  assert.deepEqual(woken.transitions, ["ACTIVE_STANDBY"]);
});

test("B6. a non-monotonic input time never moves lastInputAt backwards", () => {
  const first = input(createInitialInteractionState(), T0 + 5_000).state;
  const regressed = input(first, T0 + 1_000);
  assert.equal(regressed.state.lastInputAt, T0 + 5_000);
});

test("B7. a non-monotonic EVALUATE time never regresses a phase", () => {
  const spaceGiven = evaluate(input(createInitialInteractionState(), T0).state, T0 + 16_000).state;
  const regressed = evaluate(spaceGiven, T0 + 100);
  assert.equal(regressed.state, spaceGiven);
  assert.deepEqual(regressed.transitions, []);
});

// ============================================================
// Purity and input validation
// ============================================================

test("P1. states and steps are frozen and inputs are never mutated", () => {
  const boot = createInitialInteractionState();
  assert.ok(Object.isFrozen(boot));
  const result = input(boot, T0);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.state));
  assert.ok(Object.isFrozen(result.transitions));
  assert.equal(boot.phase, "HABITAT_IDLE");
  assert.equal(boot.lastInputAt, null);
});

test("P2. non-finite event times and unknown event types are rejected", () => {
  const boot = createInitialInteractionState();
  assert.throws(() => reduceInteraction(boot, { type: "CUSTOMER_INPUT", at: Number.NaN }), RangeError);
  assert.throws(() => reduceInteraction(boot, { type: "EVALUATE", at: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => reduceInteraction(boot, { type: "TICK", at: 1 } as never), TypeError);
  assert.throws(() => phaseForSilence(Number.NaN), RangeError);
});
