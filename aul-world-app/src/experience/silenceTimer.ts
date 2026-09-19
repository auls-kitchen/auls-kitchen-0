// Silence timer (U2) - the ONLY timer in the Experience lifecycle.
//
// It drives the pure interactionContext reducer with a monotonic clock and a
// single pending timeout. What it holds, exhaustively:
//   - a Clock          (monotonic elapsed time, never a wall clock)
//   - a Scheduler      (set/clear one timeout)
//   - interaction state (the pure reducer's state)
//   - a transition callback (presentation only)
// It holds NO Domain handle, NO AWR bus, and no other port. There is nothing
// in its reach to clear a cart, end a session, retry an order, hydrate, or
// touch identity - so a 15s / 25s / 5min expiry structurally cannot do any of
// those things.
//
// Authority: customer input is the ONLY thing that wakes or resets it.
//   - noteCustomerInput() is the single way to move it out of HABITAT_IDLE or
//     back to ACTIVE_STANDBY, and only the customer-input adapter is handed it.
//   - The timer's own timeout callback dispatches EVALUATE only. EVALUATE can
//     move a phase forward through silence; it can never wake HABITAT_IDLE and
//     never restart the silence window.
//
// Scheduling: exactly one timeout is pending at a time, aimed at the next
// threshold. On every fire the phase is recomputed from elapsed monotonic
// time (not from "the timer fired"), so a late fire (a throttled background
// tab) catches up correctly and an early fire simply reschedules.
//
// Delivery order on any change: state is updated and the next timeout is
// scheduled BEFORE callbacks run, so a throwing or re-entrant callback can
// never leave the timer without its next deadline.

import type { Clock, InputSink, Scheduler } from "../contracts.ts";
import { DEFAULT_THRESHOLDS, assertValidThresholds, createInitialInteractionState, reduceInteraction } from "./interactionContext.ts";
import type { InteractionPhase, InteractionState, InteractionStep, InteractionThresholds } from "./interactionContext.ts";

// Longest delay a platform timeout can hold (2^31 - 1 ms). A longer wait is
// scheduled in slices; each slice's fire re-evaluates and reschedules.
export const MAX_TIMEOUT_MS = 2_147_483_647;

export type TransitionCause = "CUSTOMER_INPUT" | "SILENCE";

export interface TimerTransition {
  readonly phase: InteractionPhase;
  readonly cause: TransitionCause;
  // True only for the ACTIVE_STANDBY transition that leaves HABITAT_IDLE.
  readonly wokeFromHabitat: boolean;
}

export interface SilenceTimerOptions {
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly thresholds?: InteractionThresholds;
  readonly onTransition: (transition: TimerTransition) => void;
  readonly onError?: (error: unknown) => void;
}

// A SilenceTimer is an InputSink: noteCustomerInput() is what a customer-input
// adapter calls. Nothing else in the lifecycle is given this object.
export interface SilenceTimer extends InputSink {
  start(): void;
  dispose(): void;
  getState(): InteractionState;
}

// Monotonic elapsed-time source: performance.now(). Deliberately not
// Date.now() - a wall clock can jump when the system clock is adjusted.
export function createMonotonicClock(): Clock {
  const source = globalThis.performance;
  if (!source || typeof source.now !== "function") {
    throw new Error("A monotonic clock (performance.now) is not available in this environment");
  }
  return Object.freeze({ now: (): number => source.now() });
}

export function createTimeoutScheduler(): Scheduler {
  return Object.freeze({
    set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
    clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

export function createSilenceTimer(options: SilenceTimerOptions): SilenceTimer {
  const { clock, scheduler, onTransition, onError } = options;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  assertValidThresholds(thresholds);

  let state: InteractionState = createInitialInteractionState();
  let started = false;
  let disposed = false;
  let pendingHandle: unknown = undefined;
  let hasPending = false;
  // Bumped on every schedule and clear. A callback only acts if the token it
  // captured is still current, so a stale callback (from a cleared or
  // superseded timeout, even one a scheduler fires anyway) is a no-op.
  let generation = 0;

  function report(error: unknown): void {
    try {
      onError?.(error);
    } catch {
      // The error hook itself must never break the timer.
    }
  }

  function clearPending(): void {
    if (hasPending) {
      scheduler.clear(pendingHandle);
      hasPending = false;
      pendingHandle = undefined;
    }
    generation += 1;
  }

  // Absolute monotonic time of the next threshold, or null when there is
  // nothing to wait for (HABITAT_IDLE is only ever left by customer input).
  function nextDeadlineAt(current: InteractionState): number | null {
    if (current.phase === "HABITAT_IDLE" || current.lastInputAt === null) return null;
    const offset =
      current.phase === "ACTIVE_STANDBY"
        ? thresholds.spaceGivenMs
        : current.phase === "SPACE_GIVEN"
          ? thresholds.releasedMs
          : thresholds.contextExpiredMs;
    return current.lastInputAt + offset;
  }

  function schedule(): void {
    clearPending();
    const deadline = nextDeadlineAt(state);
    if (deadline === null) return;
    const delayMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - clock.now()));
    const token = generation;
    pendingHandle = scheduler.set(() => onFire(token), delayMs);
    hasPending = true;
  }

  function deliver(before: InteractionState, step: InteractionStep, cause: TransitionCause): void {
    let previous: InteractionPhase = before.phase;
    for (const phase of step.transitions) {
      if (disposed) return;
      const wokeFromHabitat = phase === "ACTIVE_STANDBY" && previous === "HABITAT_IDLE";
      previous = phase;
      try {
        onTransition({ phase, cause, wokeFromHabitat });
      } catch (error) {
        report(error);
      }
    }
  }

  function apply(before: InteractionState, step: InteractionStep, cause: TransitionCause): void {
    state = step.state;
    schedule();
    deliver(before, step, cause);
  }

  function onFire(token: number): void {
    if (disposed || token !== generation) return;
    // This timeout has fired and is spent; there is nothing left to clear.
    hasPending = false;
    pendingHandle = undefined;
    const before = state;
    // EVALUATE only: a timer tick can advance a phase, never wake or restart.
    apply(before, reduceInteraction(before, { type: "EVALUATE", at: clock.now() }, thresholds), "SILENCE");
  }

  return Object.freeze({
    start(): void {
      if (disposed) throw new Error("SilenceTimer has been disposed; create a new instance");
      started = true;
    },

    noteCustomerInput(): void {
      // Input before start() or after dispose() is ignored.
      if (!started || disposed) return;
      const before = state;
      apply(before, reduceInteraction(before, { type: "CUSTOMER_INPUT", at: clock.now() }, thresholds), "CUSTOMER_INPUT");
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      started = false;
      clearPending();
    },

    getState(): InteractionState {
      return state;
    },
  });
}
