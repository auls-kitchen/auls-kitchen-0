// U2 targeted tests for src/experience/silenceTimer.ts.
// Brief section 16: A (timing), B (input reset), and the "timer never wakes
// Habitat" / monotonic-clock / lifecycle requirements. Fake clock + fake
// scheduler, plus a small real-timer sanity run.

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_TIMEOUT_MS, createMonotonicClock, createSilenceTimer, createTimeoutScheduler } from "../../src/experience/silenceTimer.ts";
import type { SilenceTimer, SilenceTimerOptions, TimerTransition } from "../../src/experience/silenceTimer.ts";
import type { InteractionPhase } from "../../src/experience/interactionContext.ts";
import { createFakeTime } from "./support/fakeTime.ts";

function harness(overrides: Partial<SilenceTimerOptions> = {}) {
  const time = createFakeTime();
  const transitions: TimerTransition[] = [];
  const errors: unknown[] = [];
  const timer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    onTransition: (t) => transitions.push(t),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  timer.start();
  const phases = (): InteractionPhase[] => transitions.map((t) => t.phase);
  return { time, timer, transitions, errors, phases };
}

// ============================================================
// Boot
// ============================================================

test("T1. boot: HABITAT_IDLE, started timer schedules nothing", () => {
  const { time, timer, transitions } = harness();
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  assert.equal(time.pendingCount(), 0);
  assert.deepEqual(transitions, []);
});

test("T2. input before start() is ignored", () => {
  const time = createFakeTime();
  const transitions: TimerTransition[] = [];
  const timer = createSilenceTimer({ clock: time.clock, scheduler: time.scheduler, onTransition: (t) => transitions.push(t) });
  timer.noteCustomerInput();
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  assert.equal(time.pendingCount(), 0);
  assert.deepEqual(transitions, []);
});

// ============================================================
// A. Timing
// ============================================================

test("T3. 0s: customer input -> ACTIVE_STANDBY, one timeout scheduled for 15s", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  assert.deepEqual(transitions, [{ phase: "ACTIVE_STANDBY", cause: "CUSTOMER_INPUT", wokeFromHabitat: true }]);
  assert.equal(time.pendingCount(), 1);
  assert.deepEqual(time.scheduledDelays(), [15_000]);
});

test("T4. full timeline: 15s SPACE_GIVEN, 25s RELEASED, 5min CONTEXT_EXPIRED -> HABITAT_IDLE", () => {
  const { time, timer, phases } = harness();
  timer.noteCustomerInput();

  time.advanceBy(14_999);
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  time.advanceBy(1);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  time.advanceBy(9_999);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  time.advanceBy(1);
  assert.equal(timer.getState().phase, "RELEASED");
  time.advanceBy(274_999);
  assert.equal(timer.getState().phase, "RELEASED");
  time.advanceBy(1);
  assert.equal(timer.getState().phase, "HABITAT_IDLE");

  assert.deepEqual(phases(), ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

test("T5. each timeout is aimed at the next threshold from the LAST input (15s, +10s, +275s)", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  time.advanceBy(300_000);
  assert.deepEqual(time.scheduledDelays(), [15_000, 10_000, 275_000]);
});

test("T6. exactly one timeout is ever pending, and none once Habitat is reached", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  assert.equal(time.pendingCount(), 1);
  time.advanceBy(15_000);
  assert.equal(time.pendingCount(), 1);
  time.advanceBy(10_000);
  assert.equal(time.pendingCount(), 1);
  time.advanceBy(275_000);
  assert.equal(time.pendingCount(), 0);
  assert.equal(time.maxPendingSeen(), 1);
});

test("T7. late fire (throttled tab): one firing catches up through every crossed phase in order", () => {
  const { time, timer, phases } = harness();
  timer.noteCustomerInput();
  time.jumpBy(400_000); // the 15s timeout is now 385s overdue
  assert.equal(time.pendingCount(), 1);
  time.fireDue();
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  assert.deepEqual(phases(), ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
  assert.equal(time.pendingCount(), 0);
});

test("T8. early fire (scheduler fires 10ms before the clock reaches the deadline): no transition, remainder rescheduled", () => {
  let now = 100;
  const callbacks: Array<{ callback: () => void; delayMs: number }> = [];
  const scheduler = {
    set: (callback: () => void, delayMs: number) => {
      callbacks.push({ callback, delayMs });
      return callbacks.length;
    },
    clear: () => {},
  };
  const seen: InteractionPhase[] = [];
  const timer = createSilenceTimer({ clock: { now: () => now }, scheduler, onTransition: (t) => seen.push(t.phase) });
  timer.start();
  timer.noteCustomerInput(); // input at 100 -> 15s timeout
  assert.equal(callbacks[0]!.delayMs, 15_000);

  now = 100 + 14_990;
  callbacks[0]!.callback(); // fired 10ms early
  assert.deepEqual(seen, ["ACTIVE_STANDBY"], "an early fire must not advance the phase");
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  assert.equal(callbacks.length, 2);
  assert.ok(Math.abs(callbacks[1]!.delayMs - 10) < 1e-6, `remainder was ${callbacks[1]!.delayMs}ms`);

  now = 100 + 15_000;
  callbacks[1]!.callback();
  assert.deepEqual(seen, ["ACTIVE_STANDBY", "SPACE_GIVEN"]);
});

// ============================================================
// B. Input reset
// ============================================================

test("T9. input restarts the silence window: the old timeout is cleared and a fresh 15s one set", () => {
  const { time, timer, phases } = harness();
  timer.noteCustomerInput();
  time.advanceBy(10_000);
  timer.noteCustomerInput();
  assert.equal(time.pendingCount(), 1);
  assert.equal(time.clearCount() >= 1, true);

  time.advanceBy(14_999);
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  time.advanceBy(1);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  assert.deepEqual(phases(), ["ACTIVE_STANDBY", "SPACE_GIVEN"]);
});

test("T10. input during SPACE_GIVEN and RELEASED returns to ACTIVE_STANDBY", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.advanceBy(20_000);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  timer.noteCustomerInput();
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");

  time.advanceBy(100_000);
  assert.equal(timer.getState().phase, "RELEASED");
  timer.noteCustomerInput();
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");

  // Only the first (boot) input woke from Habitat; the other two were resets.
  assert.deepEqual(
    transitions.filter((t) => t.cause === "CUSTOMER_INPUT").map((t) => t.wokeFromHabitat),
    [true, false, false],
  );
});

test("T11. input just before 5min expiry prevents Habitat", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  time.advanceBy(299_999);
  assert.equal(timer.getState().phase, "RELEASED");
  timer.noteCustomerInput();
  time.advanceBy(1);
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
});

// ============================================================
// Authority: the timer never wakes Habitat and never resets silence
// ============================================================

test("T12. the timer's own firing never wakes HABITAT_IDLE", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.advanceBy(300_000);
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  const habitatTransitions = transitions.length;

  // An hour of time, every callback the scheduler could possibly fire, stale ones too.
  time.advanceBy(3_600_000);
  time.fireDue();
  time.fireStale();

  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  assert.equal(transitions.length, habitatTransitions);
  assert.equal(time.pendingCount(), 0);
});

test("T13. every transition after the first wake is caused by SILENCE, never by the timer restarting itself", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.advanceBy(500_000);
  const afterWake = transitions.slice(1);
  assert.ok(afterWake.length > 0);
  assert.ok(afterWake.every((t) => t.cause === "SILENCE"));
  assert.ok(afterWake.every((t) => t.wokeFromHabitat === false));
  assert.equal(transitions.filter((t) => t.phase === "ACTIVE_STANDBY").length, 1);
});

test("T14. a firing timeout does not restart the silence window (lastInputAt is untouched)", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  const inputAt = timer.getState().lastInputAt;
  time.advanceBy(20_000);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  assert.equal(timer.getState().lastInputAt, inputAt);
});

test("T15. a non-monotonic clock never regresses a phase or lengthens silence", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  time.advanceBy(20_000);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  time.setNow(time.now() - 15_000); // clock jumps backwards
  time.fireDue();
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  assert.equal(time.pendingCount(), 1, "the next deadline is still scheduled");
});

// ============================================================
// H. Lifecycle / disposal
// ============================================================

test("T16. dispose() clears the pending timeout; later input and stale callbacks are no-ops", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  assert.equal(time.pendingCount(), 1);
  const before = transitions.length;

  timer.dispose();
  assert.equal(time.pendingCount(), 0);

  timer.noteCustomerInput();
  time.advanceBy(600_000);
  const stale = time.fireStale(); // the cleared callback, fired anyway
  assert.equal(stale, 1);
  assert.equal(transitions.length, before, "no transition after dispose");
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
});

test("T17. dispose() is idempotent and start() after dispose throws", () => {
  const { timer, time } = harness();
  timer.dispose();
  assert.doesNotThrow(() => timer.dispose());
  assert.throws(() => timer.start(), /disposed/);
  assert.equal(time.pendingCount(), 0);
});

test("T18. a superseded timeout is stale: firing it after input changes nothing", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.advanceBy(10_000);
  timer.noteCustomerInput(); // clears and supersedes the first timeout
  const before = transitions.length;
  const scheduledBefore = time.scheduledDelays().length;
  assert.equal(time.pendingCount(), 1);

  assert.equal(time.fireStale(), 1); // the superseded callback, fired anyway
  assert.equal(transitions.length, before);
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  // A stale fire must not disturb the live timeout's bookkeeping: it must not
  // schedule anything, and the one real pending timeout must still be exactly one.
  assert.equal(time.scheduledDelays().length, scheduledBefore, "a stale fire scheduled a new timeout");
  assert.equal(time.pendingCount(), 1, "a stale fire left the wrong number of timeouts pending");

  // And the live timeout still works.
  time.advanceBy(15_000);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
});

test("T19. disposing from inside a transition callback stops the remaining deliveries", () => {
  const time = createFakeTime();
  const seen: InteractionPhase[] = [];
  const timer: SilenceTimer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    onTransition: (t) => {
      seen.push(t.phase);
      if (t.phase === "RELEASED") timer.dispose();
    },
  });
  timer.start();
  timer.noteCustomerInput();
  time.jumpBy(400_000);
  time.fireDue(); // would deliver SPACE_GIVEN, RELEASED, CONTEXT_EXPIRED, HABITAT_IDLE
  assert.deepEqual(seen, ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED"]);
});

test("T20. a throwing transition callback is isolated: the next deadline is still scheduled", () => {
  const time = createFakeTime();
  const errors: unknown[] = [];
  const timer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    onTransition: () => {
      throw new Error("presentation blew up");
    },
    onError: (e) => errors.push(e),
  });
  timer.start();
  timer.noteCustomerInput();
  assert.equal(errors.length, 1);
  assert.equal(time.pendingCount(), 1, "deadline scheduled before callbacks ran");
  time.advanceBy(15_000);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  assert.equal(errors.length, 2);
});

test("T21. a throwing onError hook cannot break the timer", () => {
  const time = createFakeTime();
  const timer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    onTransition: () => {
      throw new Error("callback");
    },
    onError: () => {
      throw new Error("hook");
    },
  });
  timer.start();
  assert.doesNotThrow(() => timer.noteCustomerInput());
  time.advanceBy(300_000);
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
});

// ============================================================
// Thresholds, limits, defaults
// ============================================================

test("T22. custom thresholds are honored and invalid ones are rejected at construction", () => {
  const time = createFakeTime();
  const timer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    thresholds: { spaceGivenMs: 150, releasedMs: 250, contextExpiredMs: 3_000 },
    onTransition: () => {},
  });
  timer.start();
  timer.noteCustomerInput();
  time.advanceBy(150);
  assert.equal(timer.getState().phase, "SPACE_GIVEN");
  time.advanceBy(100);
  assert.equal(timer.getState().phase, "RELEASED");
  time.advanceBy(2_750);
  assert.equal(timer.getState().phase, "HABITAT_IDLE");

  assert.throws(
    () =>
      createSilenceTimer({
        clock: time.clock,
        scheduler: time.scheduler,
        thresholds: { spaceGivenMs: 50, releasedMs: 40, contextExpiredMs: 60 },
        onTransition: () => {},
      }),
    RangeError,
  );
});

test("T23. a wait longer than a platform timeout is scheduled in slices and still completes", () => {
  const huge = MAX_TIMEOUT_MS * 2;
  const time = createFakeTime();
  const timer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    thresholds: { spaceGivenMs: 10, releasedMs: 20, contextExpiredMs: huge },
    onTransition: () => {},
  });
  timer.start();
  timer.noteCustomerInput();
  time.advanceBy(huge + 1);
  assert.equal(timer.getState().phase, "HABITAT_IDLE");
  assert.ok(time.scheduledDelays().every((d) => d <= MAX_TIMEOUT_MS), `a delay exceeded ${MAX_TIMEOUT_MS}`);
});

test("T24. the default clock is monotonic performance.now(), not a wall clock", () => {
  const clock = createMonotonicClock();
  let previous = clock.now();
  for (let i = 0; i < 2_000; i++) {
    const current = clock.now();
    assert.ok(current >= previous, "clock ran backwards");
    previous = current;
  }
  assert.ok(Math.abs(clock.now() - performance.now()) < 50, "default clock is not performance.now()");
});

test("T25. the default scheduler fires a timeout and honors clear()", async () => {
  const scheduler = createTimeoutScheduler();
  let fired = 0;
  let clearedFired = 0;
  scheduler.set(() => fired++, 5);
  const handle = scheduler.set(() => clearedFired++, 5);
  scheduler.clear(handle);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  assert.equal(clearedFired, 0);
});

test("T26. real clock + real timeouts (scaled thresholds): full timeline, each phase no earlier than its threshold", async () => {
  const clock = createMonotonicClock();
  const scheduler = createTimeoutScheduler();
  const thresholds = { spaceGivenMs: 30, releasedMs: 60, contextExpiredMs: 150 };
  const seen: Array<{ phase: InteractionPhase; at: number }> = [];
  const timer = createSilenceTimer({
    clock,
    scheduler,
    thresholds,
    onTransition: (t) => seen.push({ phase: t.phase, at: clock.now() }),
  });
  timer.start();
  const inputAt = clock.now();
  timer.noteCustomerInput();

  const deadline = performance.now() + 3_000;
  while (timer.getState().phase !== "HABITAT_IDLE" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  timer.dispose();

  assert.deepEqual(
    seen.map((s) => s.phase),
    ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"],
  );
  const at = (phase: InteractionPhase) => seen.find((s) => s.phase === phase)!.at - inputAt;
  assert.ok(at("SPACE_GIVEN") >= 30, `SPACE_GIVEN came at ${at("SPACE_GIVEN")}ms`);
  assert.ok(at("RELEASED") >= 60, `RELEASED came at ${at("RELEASED")}ms`);
  assert.ok(at("HABITAT_IDLE") >= 150, `HABITAT_IDLE came at ${at("HABITAT_IDLE")}ms`);
});

// ============================================================
// Evaluate-before-input (U4 Slice 2A): the phase an input finds is decided by
// ELAPSED monotonic time, never by whether a late timeout fired first.
// ============================================================

test("T27. an input reports the phase it found, from elapsed time: 10s ACTIVE_STANDBY, 20s SPACE_GIVEN, 26s RELEASED", () => {
  for (const [elapsed, expected] of [
    [10_000, "ACTIVE_STANDBY"],
    [20_000, "SPACE_GIVEN"],
    [26_000, "RELEASED"],
  ] as const) {
    const { time, timer } = harness();
    timer.noteCustomerInput();
    time.advanceBy(elapsed); // a punctual scheduler
    assert.deepEqual(timer.noteCustomerInput(), { phaseBefore: expected }, `${elapsed}ms`);
    assert.equal(timer.getState().phase, "ACTIVE_STANDBY", "the input then restarts the window");
  }
});

test("T28. the boundaries are exact and inclusive: 14.999s / 15s and 24.999s / 25s", () => {
  for (const [elapsed, expected] of [
    [14_999, "ACTIVE_STANDBY"],
    [15_000, "SPACE_GIVEN"],
    [24_999, "SPACE_GIVEN"],
    [25_000, "RELEASED"],
    [299_999, "RELEASED"],
  ] as const) {
    const { time, timer } = harness();
    timer.noteCustomerInput();
    time.jumpBy(elapsed); // late scheduler: nothing has fired
    assert.equal(timer.noteCustomerInput()?.phaseBefore, expected, `${elapsed}ms`);
  }
});

test("T29. LATE TIMER: 30s of silence, the 25s callback has NOT fired - the input still finds RELEASED, and the missed phases are reported in order first", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.jumpBy(30_000);
  assert.equal(time.pendingCount(), 1, "a timeout is pending and overdue");
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY", "the timer has not caught up on its own");
  transitions.length = 0;

  const observation = timer.noteCustomerInput();

  assert.deepEqual(observation, { phaseBefore: "RELEASED" });
  assert.deepEqual(
    transitions.map((t) => [t.phase, t.cause]),
    [
      ["SPACE_GIVEN", "SILENCE"],
      ["RELEASED", "SILENCE"],
      ["ACTIVE_STANDBY", "CUSTOMER_INPUT"],
    ],
    "evaluated first, then the input",
  );
  assert.equal(timer.getState().phase, "ACTIVE_STANDBY");
  assert.equal(time.pendingCount(), 1, "exactly one fresh 15s timeout; the overdue one is gone");
});

test("T30. LATE TIMER past 5 minutes: the expiry is delivered BEFORE the wake, and the input reports HABITAT_IDLE", () => {
  const { time, timer, transitions } = harness();
  timer.noteCustomerInput();
  time.jumpBy(360_000);
  transitions.length = 0;

  const observation = timer.noteCustomerInput();

  assert.deepEqual(observation, { phaseBefore: "HABITAT_IDLE" });
  assert.deepEqual(
    transitions.map((t) => [t.phase, t.cause, t.wokeFromHabitat]),
    [
      ["SPACE_GIVEN", "SILENCE", false],
      ["RELEASED", "SILENCE", false],
      ["CONTEXT_EXPIRED", "SILENCE", false],
      ["HABITAT_IDLE", "SILENCE", false],
      ["ACTIVE_STANDBY", "CUSTOMER_INPUT", true],
    ],
  );
  assert.equal(time.pendingCount(), 1);
});

test("T31. an input at HABITAT_IDLE reports HABITAT_IDLE and wakes; only INPUT ever wakes (an evaluation alone never does)", () => {
  const woken = harness();
  assert.deepEqual(woken.timer.noteCustomerInput(), { phaseBefore: "HABITAT_IDLE" });
  assert.deepEqual(woken.transitions, [{ phase: "ACTIVE_STANDBY", cause: "CUSTOMER_INPUT", wokeFromHabitat: true }]);

  const silent = harness();
  silent.time.advanceBy(3_600_000);
  silent.time.fireDue();
  assert.equal(silent.timer.getState().phase, "HABITAT_IDLE");
  assert.deepEqual(silent.transitions, []);
});

test("T32. evaluating first adds no scheduling churn when nothing was crossed: one timeout per input, as before", () => {
  const { time, timer } = harness();
  timer.noteCustomerInput();
  assert.deepEqual(time.scheduledDelays(), [15_000]);
  time.advanceBy(5_000);
  timer.noteCustomerInput(); // nothing crossed
  timer.noteCustomerInput();
  assert.equal(time.scheduledDelays().length, 3, "exactly one schedule per input");
  assert.equal(time.pendingCount(), 1);
});

test("T33. the input kind never changes what the timer does: press, drag, wheel and no kind are identical", () => {
  const outcomes = ([undefined, "press", "drag", "wheel"] as const).map((kind) => {
    const { time, timer, transitions } = harness();
    timer.noteCustomerInput();
    time.jumpBy(30_000);
    const observation = timer.noteCustomerInput(kind);
    return JSON.stringify({ observation, phases: transitions.map((t) => t.phase), state: timer.getState().phase, pending: time.pendingCount() });
  });
  assert.equal(new Set(outcomes).size, 1, outcomes.join(" | "));
});

test("T34. an ignored input returns null: before start() and after dispose()", () => {
  const time = createFakeTime();
  const timer = createSilenceTimer({ clock: time.clock, scheduler: time.scheduler, onTransition: () => {} });
  assert.equal(timer.noteCustomerInput("press"), null, "before start");
  timer.start();
  assert.deepEqual(timer.noteCustomerInput("press"), { phaseBefore: "HABITAT_IDLE" });
  timer.dispose();
  assert.equal(timer.noteCustomerInput("press"), null, "after dispose");
});

test("T35. a callback that disposes the timer during the evaluation stops the input: null, and no wake is delivered", () => {
  const time = createFakeTime();
  const seen: InteractionPhase[] = [];
  const timer: SilenceTimer = createSilenceTimer({
    clock: time.clock,
    scheduler: time.scheduler,
    onTransition: (t) => {
      seen.push(t.phase);
      if (t.phase === "RELEASED") timer.dispose();
    },
  });
  timer.start();
  timer.noteCustomerInput();
  time.jumpBy(400_000);
  seen.length = 0;

  assert.equal(timer.noteCustomerInput("press"), null);
  assert.deepEqual(seen, ["SPACE_GIVEN", "RELEASED"], "nothing after the dispose: no expiry, no wake");
});

test("T36. the observation is frozen and carries only the phase", () => {
  const { timer } = harness();
  const observation = timer.noteCustomerInput("press");
  assert.ok(Object.isFrozen(observation));
  assert.deepEqual(Object.keys(observation!), ["phaseBefore"]);
});
