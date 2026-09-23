// Experience interaction context (U1) - pure reducer, no I/O.
//
//   customer input -> ACTIVE_STANDBY
//   ACTIVE_STANDBY --15s silence--> SPACE_GIVEN
//   SPACE_GIVEN    --25s silence--> RELEASED
//   RELEASED       --5min silence--> CONTEXT_EXPIRED -> HABITAT_IDLE
//
// This measures SILENCE, never business completion. It is Experience-only
// state: it is never written into, derived from, or synchronized with the
// Kiosk Domain session, and it holds no handle to the Domain at all.
//
// Time is an INPUT. Every event carries `at`, a number the caller reads
// from a monotonic elapsed-time source; this module never reads a clock of
// its own, so it is fully deterministic and trivially testable. The
// (later) timer driver owns the clock.
//
// Approved decisions encoded here:
//   - Boot state is HABITAT_IDLE (no customer input has happened yet).
//   - CONTEXT_EXPIRED is TRANSIENT: it is reported as a transition on the
//     way to HABITAT_IDLE and never rests as a state (see RestingPhase).
//   - Only customer input wakes HABITAT_IDLE. An EVALUATE (a timer tick)
//     never does - the timer cannot masquerade as customer input.
//
// Catch-up: EVALUATE reports EVERY phase crossed since the last state, in
// order, so a late timer (e.g. a throttled background tab) still hands the
// presentation layer a complete, ordered sequence rather than a silent jump.

export type InteractionPhase = "ACTIVE_STANDBY" | "SPACE_GIVEN" | "RELEASED" | "CONTEXT_EXPIRED" | "HABITAT_IDLE";

// CONTEXT_EXPIRED is transient, so it can never be a state the machine rests in.
export type RestingPhase = Exclude<InteractionPhase, "CONTEXT_EXPIRED">;

export interface InteractionThresholds {
  readonly spaceGivenMs: number;
  readonly releasedMs: number;
  readonly contextExpiredMs: number;
}

// The approved ~15s / ~25s / ~5min silence thresholds, measured from the
// last customer input.
export const DEFAULT_THRESHOLDS: InteractionThresholds = Object.freeze({
  spaceGivenMs: 15_000,
  releasedMs: 25_000,
  contextExpiredMs: 300_000,
});

export interface InteractionState {
  readonly phase: RestingPhase;
  // Monotonic time of the last customer input; null exactly when HABITAT_IDLE.
  readonly lastInputAt: number | null;
}

export type InteractionEvent =
  | { readonly type: "CUSTOMER_INPUT"; readonly at: number }
  | { readonly type: "EVALUATE"; readonly at: number };

export interface InteractionStep {
  readonly state: InteractionState;
  // Every phase entered by this event, in order. Empty when nothing changed.
  readonly transitions: readonly InteractionPhase[];
}

// The phases an active interaction moves through, in order.
const ACTIVE_ORDER = ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED"] as const;

export function createInitialInteractionState(): InteractionState {
  return Object.freeze({ phase: "HABITAT_IDLE", lastInputAt: null });
}

export function assertValidThresholds(thresholds: InteractionThresholds): void {
  const { spaceGivenMs, releasedMs, contextExpiredMs } = thresholds;
  const allPositiveFinite = [spaceGivenMs, releasedMs, contextExpiredMs].every((v) => Number.isFinite(v) && v > 0);
  if (!allPositiveFinite) {
    throw new RangeError("Interaction thresholds must be positive, finite numbers");
  }
  if (!(spaceGivenMs < releasedMs && releasedMs < contextExpiredMs)) {
    throw new RangeError("Interaction thresholds must be strictly increasing: spaceGivenMs < releasedMs < contextExpiredMs");
  }
}

// Maps elapsed silence to the phase it corresponds to. Boundaries are
// inclusive: exactly at a threshold, the later phase applies.
export function phaseForSilence(
  elapsedMs: number,
  thresholds: InteractionThresholds = DEFAULT_THRESHOLDS,
): Exclude<InteractionPhase, "HABITAT_IDLE"> {
  if (!Number.isFinite(elapsedMs)) {
    throw new RangeError("elapsedMs must be a finite number");
  }
  assertValidThresholds(thresholds);
  if (elapsedMs >= thresholds.contextExpiredMs) return "CONTEXT_EXPIRED";
  if (elapsedMs >= thresholds.releasedMs) return "RELEASED";
  if (elapsedMs >= thresholds.spaceGivenMs) return "SPACE_GIVEN";
  return "ACTIVE_STANDBY";
}

function step(state: InteractionState, transitions: readonly InteractionPhase[]): InteractionStep {
  return Object.freeze({ state, transitions: Object.freeze([...transitions]) });
}

function onCustomerInput(state: InteractionState, at: number): InteractionStep {
  // A monotonic source never runs backwards; if it ever did, the last input
  // time still must not move backwards (that would lengthen the silence).
  const lastInputAt = state.lastInputAt === null ? at : Math.max(state.lastInputAt, at);
  const next: InteractionState = Object.freeze({ phase: "ACTIVE_STANDBY", lastInputAt });
  // Repeated input while already ACTIVE_STANDBY restarts the silence window
  // but is not a new phase, so it reports no transition.
  return step(next, state.phase === "ACTIVE_STANDBY" ? [] : ["ACTIVE_STANDBY"]);
}

function onEvaluate(state: InteractionState, at: number, thresholds: InteractionThresholds): InteractionStep {
  // HABITAT_IDLE is only ever left by customer input. A null lastInputAt in
  // any other phase is unreachable through this reducer; treat it as a no-op.
  if (state.phase === "HABITAT_IDLE" || state.lastInputAt === null) {
    return step(state, []);
  }

  const elapsedMs = Math.max(0, at - state.lastInputAt);
  const target = phaseForSilence(elapsedMs, thresholds);
  const fromIndex = ACTIVE_ORDER.indexOf(state.phase);
  const toIndex = ACTIVE_ORDER.indexOf(target);

  // Phases only ever advance through silence; they never move backwards.
  if (toIndex <= fromIndex) {
    return step(state, []);
  }

  const crossed = ACTIVE_ORDER.slice(fromIndex + 1, toIndex + 1);

  if (target === "CONTEXT_EXPIRED") {
    // CONTEXT_EXPIRED is transient: report it, then rest in HABITAT_IDLE.
    return step(Object.freeze({ phase: "HABITAT_IDLE", lastInputAt: null }), [...crossed, "HABITAT_IDLE"]);
  }

  return step(Object.freeze({ phase: target, lastInputAt: state.lastInputAt }), crossed);
}

function assertFiniteTime(at: number): void {
  if (!Number.isFinite(at)) {
    throw new RangeError("Interaction event time `at` must be a finite number");
  }
}

// Pure (state, event) -> step. Never mutates its input, never reads a clock,
// never touches the Domain.
export function reduceInteraction(
  state: InteractionState,
  event: InteractionEvent,
  thresholds: InteractionThresholds = DEFAULT_THRESHOLDS,
): InteractionStep {
  assertValidThresholds(thresholds);
  assertFiniteTime(event.at);

  switch (event.type) {
    case "CUSTOMER_INPUT":
      return onCustomerInput(state, event.at);
    case "EVALUATE":
      return onEvaluate(state, event.at, thresholds);
    default:
      throw new TypeError(`Unknown interaction event type: ${String((event as { type: unknown }).type)}`);
  }
}
