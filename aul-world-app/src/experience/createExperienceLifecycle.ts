// Experience lifecycle (U2) - wires the silence timer, the customer-input
// adapter, and the pure pending-ticket router into one mountable unit.
//
//   customer input (DOM) -> customerInput -> sink -> silenceTimer -> phase
//   phase changes        -> onPhase (presentation callback, for the shell)
//   HABITAT_IDLE entered -> presentation.returnToWorld(), only if AWR is in ORDERING
//   woke from HABITAT    -> read ONE Domain snapshot -> routeCustomerReturn -> onWake
//
// Everything the lifecycle can touch is a narrow port passed in by the caller:
//   snapshots    read-only Domain access (getSnapshot only)
//   presentation the single AWR output it may drive (returnToWorld only)
//   world        a boolean probe: is AWR currently presenting ORDERING?
//   clock, scheduler, inputTarget
// There is no Domain handle, no AWR bus, and no host here. The lifecycle
// therefore cannot clear a cart, end a session, retry an order, hydrate,
// rotate identity, or purge anything - at 15s, 25s, 5min, on wake, or ever.
//
// Phase-before-input: a customer PRESS (a tap/click, or Enter/Space on an
// interactive element) latches the phase the silence clock had reached, from
// elapsed monotonic time, BEFORE that press restarted it. Only a press latches;
// a drag or a wheel never touches the latch. Every new press overwrites it (so
// a later press at ACTIVE_STANDBY can never inherit an older RELEASED), and
// consumeGesture() hands it out exactly once. This is the one thing the shell's
// Home/X activation needs to know and could not see, because by the time a
// `click` arrives the press has already reset the window. It is data only: a
// phase name, no Domain handle, no callback.
//
// The returned object exposes only start / dispose / getPhase / consumeGesture.
// The sink that carries customer input is created here and given to the input
// adapter and to nobody else; it is never returned.
//
// One instance per mount, no module-level state. Re-mounting means creating a
// new instance after dispose(); a disposed instance cannot be started again.

import type { Clock, CustomerInputKind, PresentationOutPort, Scheduler, SnapshotReadPort } from "../contracts.ts";
import { attachCustomerInput } from "./customerInput.ts";
import type { CustomerInputBinding, InteractiveTargetPredicate } from "./customerInput.ts";
import type { InteractionPhase, InteractionThresholds, RestingPhase } from "./interactionContext.ts";
import { routeCustomerReturn } from "./pendingTicket.ts";
import type { WakeDecision } from "./pendingTicket.ts";
import { createSilenceTimer } from "./silenceTimer.ts";
import type { TimerTransition } from "./silenceTimer.ts";

// Read-only probe of AWR's presentation mode. Supplied by the Composition
// root, which owns AWR's state; the lifecycle never sees AWR itself.
export interface WorldPresentationProbe {
  isOrdering(): boolean;
}

export interface ExperienceLifecycleOptions {
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly inputTarget: EventTarget;
  readonly snapshots: SnapshotReadPort;
  readonly presentation: PresentationOutPort;
  readonly world: WorldPresentationProbe;
  readonly thresholds?: InteractionThresholds;
  readonly isInteractiveTarget?: InteractiveTargetPredicate;
  // Presentation-only callback: every phase entered, in order (including the
  // transient CONTEXT_EXPIRED). For the future shell; carries no business data.
  readonly onPhase?: (phase: InteractionPhase) => void;
  // Called once per wake from HABITAT_IDLE with where the customer should go.
  readonly onWake?: (decision: WakeDecision) => void;
  readonly onError?: (error: unknown) => void;
}

// The phase the Experience was in before the press that started a gesture.
export interface HomeGesture {
  readonly phaseBefore: RestingPhase;
}

export interface ExperienceLifecycle {
  start(): void;
  dispose(): void;
  getPhase(): RestingPhase;
  // The latched press, once: the first call after a press returns it, every
  // later call returns null until the next press.
  consumeGesture(): HomeGesture | null;
}

export function createExperienceLifecycle(options: ExperienceLifecycleOptions): ExperienceLifecycle {
  const { clock, scheduler, inputTarget, snapshots, presentation, world, onPhase, onWake, onError } = options;

  let started = false;
  let disposed = false;
  let inputBinding: CustomerInputBinding | null = null;

  function report(error: unknown): void {
    try {
      onError?.(error);
    } catch {
      // The error hook must never break the lifecycle.
    }
  }

  function enterHabitat(): void {
    try {
      // returnToWorld only when AWR is actually presenting ORDERING; otherwise
      // there is nothing to return from and no event is emitted.
      if (world.isOrdering()) presentation.returnToWorld();
    } catch (error) {
      report(error);
    }
  }

  function wake(): void {
    let decision: WakeDecision;
    try {
      // Exactly one snapshot read per wake, taken at the moment of input.
      decision = routeCustomerReturn(snapshots.getSnapshot());
    } catch (error) {
      report(error);
      // Fail closed: an unreadable Domain is "not ready", never "no ticket".
      decision = routeCustomerReturn(null);
    }
    try {
      onWake?.(decision);
    } catch (error) {
      report(error);
    }
  }

  function handleTransition(transition: TimerTransition): void {
    try {
      onPhase?.(transition.phase);
    } catch (error) {
      report(error);
    }
    if (transition.phase === "HABITAT_IDLE") enterHabitat();
    if (transition.wokeFromHabitat) wake();
  }

  const timer = createSilenceTimer({
    clock,
    scheduler,
    thresholds: options.thresholds,
    onTransition: handleTransition,
    onError: report,
  });

  // The latched phase-before-input of the most recent press, or null.
  let gesture: HomeGesture | null = null;

  // The only holder of customer input authority besides the timer itself.
  const sink = Object.freeze({
    noteCustomerInput: (kind?: CustomerInputKind): void => {
      // A new press replaces whatever an earlier press latched - cleared BEFORE
      // the timer runs, so a callback fired by this very input can never read
      // the previous press's phase.
      if (kind === "press") gesture = null;
      const observation = timer.noteCustomerInput(kind);
      if (kind === "press" && observation !== null) {
        gesture = Object.freeze({ phaseBefore: observation.phaseBefore });
      }
    },
  });

  function consumeGesture(): HomeGesture | null {
    const latched = gesture;
    gesture = null;
    return latched;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    started = false;
    gesture = null;
    inputBinding?.dispose();
    inputBinding = null;
    timer.dispose();
  }

  function start(): void {
    if (disposed) throw new Error("ExperienceLifecycle has been disposed; create a new instance");
    if (started) return;
    started = true;
    try {
      timer.start();
      inputBinding = attachCustomerInput(inputTarget, sink, { isInteractiveTarget: options.isInteractiveTarget });
    } catch (error) {
      // Never leave a half-started lifecycle behind.
      dispose();
      throw error;
    }
  }

  return Object.freeze({
    start,
    dispose,
    getPhase: (): RestingPhase => timer.getState().phase,
    consumeGesture,
  });
}
