// Context transitions coordinator (U4 Slice 2B, S2) - pure, injected, unwired.
//
// One release of the previous customer's context may be in flight at a time.
// This module coordinates that release and nothing else:
//
//   single-flight   the in-flight gate is raised SYNCHRONOUSLY, before anything can
//                   await; concurrent release() calls join the one operation (the
//                   very same Promise) and receive the same verdict; the cause that
//                   started it stays the active cause
//   classification  a release result becomes one of two verdicts, FRESH or
//                   UNAVAILABLE. Fail closed: only an explicit RELEASED or
//                   NOTHING_TO_RELEASE is FRESH; a refusal, an error outcome, a
//                   malformed result, a rejection and a throw are all UNAVAILABLE
//   settle order    afterSettle() callbacks are Promise reactions on the in-flight
//                   promise, so they run after the verdict is known and in strict
//                   registration order, interleaved correctly with anyone who
//                   `await`ed release(): whoever registered first runs first
//   never rejects   release() cannot reject; every failure is an UNAVAILABLE verdict
//                   that has also been offered to onError. There is no retry
//   disposal        dispose() stops new releases and drops pending callbacks. A
//                   release that is already running is NOT cancelled: it settles on
//                   its own, and nothing this module owns fires afterwards
//
// What it does not know: the Domain. It receives `release` as a plain function and
// never names, inspects, or logs the Domain's method, snapshots or customer data.
// The Composition root will be the only place that supplies that function.
// It reads no clock and touches no DOM, timer, storage or network.

export type ReleaseCause = "TAKEOVER" | "EXPIRY" | "WAKE_RECONCILE" | "REBOOT_BOUNDARY";

export type ReleaseVerdict = "FRESH" | "UNAVAILABLE";

// Stable, coordinator-level constants only: no Domain data, no result, no error text.
export type ContextTransitionEvent =
  | { readonly type: "RELEASE_STARTED"; readonly cause: ReleaseCause }
  | { readonly type: "RELEASE_JOINED"; readonly cause: ReleaseCause; readonly joinedCause: ReleaseCause }
  | { readonly type: "RELEASE_SETTLED"; readonly cause: ReleaseCause; readonly verdict: ReleaseVerdict };

export interface ContextTransitions {
  // Starts a release, or joins the one in flight. Never rejects.
  release(cause: ReleaseCause): Promise<ReleaseVerdict>;
  // True from the instant release() first returns until the release has settled.
  isSettling(): boolean;
  // Runs `callback` once the release in flight has settled (after its verdict is
  // known), in registration order. With no release in flight there is nothing to
  // wait for, so it runs on the next microtask - never synchronously. Dropped
  // after dispose().
  afterSettle(callback: () => void): void;
  dispose(): void;
}

export interface ContextTransitionsOptions {
  readonly release: () => Promise<unknown>;
  readonly onTransition?: (event: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

// FRESH only for an explicit outcome of RELEASED or NOTHING_TO_RELEASE (the latter
// means the Domain itself confirmed there was no releasable customer context).
// Everything else - REFUSED, an error outcome, any other value, a non-object, a
// hostile object - is UNAVAILABLE. Total: it never throws.
export function classifyReleaseResult(result: unknown): ReleaseVerdict {
  if (typeof result !== "object" || result === null) return "UNAVAILABLE";
  let outcome: unknown;
  try {
    outcome = (result as { readonly outcome?: unknown }).outcome;
  } catch {
    return "UNAVAILABLE";
  }
  return outcome === "RELEASED" || outcome === "NOTHING_TO_RELEASE" ? "FRESH" : "UNAVAILABLE";
}

export function createContextTransitions(options: ContextTransitionsOptions): ContextTransitions {
  if (typeof options !== "object" || options === null || typeof options.release !== "function") {
    throw new TypeError("createContextTransitions requires a `release` function");
  }
  const injectedRelease = options.release;

  let disposed = false;
  let inFlight: Promise<ReleaseVerdict> | null = null;
  let activeCause: ReleaseCause | null = null;

  // Hooks may throw; nothing they do can break the coordinator.
  function report(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // The error hook must never break the coordinator.
    }
  }

  // Suppressed after dispose(): a disposed coordinator triggers no further hook.
  function emit(event: ContextTransitionEvent): void {
    if (disposed) return;
    try {
      options.onTransition?.(event);
    } catch (error) {
      report(error);
    }
  }

  // Runs the injected release. It cannot throw and cannot reject: every failure is
  // a verdict. State is cleared BEFORE the promise resolves, so any callback or
  // continuation that runs afterwards sees a coordinator that is free again.
  async function run(cause: ReleaseCause, settle: (verdict: ReleaseVerdict) => void): Promise<void> {
    let verdict: ReleaseVerdict = "UNAVAILABLE";
    try {
      // A synchronous throw from the injected function lands in this catch too.
      verdict = classifyReleaseResult(await injectedRelease());
    } catch (error) {
      report(error);
    }
    inFlight = null;
    activeCause = null;
    emit({ type: "RELEASE_SETTLED", cause, verdict });
    settle(verdict);
  }

  function release(cause: ReleaseCause): Promise<ReleaseVerdict> {
    if (disposed) return Promise.resolve("UNAVAILABLE");

    if (inFlight !== null) {
      // Join. The first cause stays active; a later one is only reported.
      emit({ type: "RELEASE_JOINED", cause: activeCause ?? cause, joinedCause: cause });
      return inFlight;
    }

    let settle!: (verdict: ReleaseVerdict) => void;
    const promise = new Promise<ReleaseVerdict>((resolve) => {
      settle = resolve;
    });
    // The gate goes up here, synchronously, before the injected function is even
    // called - so even the synchronous part of it (or a hook) that calls back into
    // release() joins this operation instead of starting another.
    inFlight = promise;
    activeCause = cause;
    emit({ type: "RELEASE_STARTED", cause });
    void run(cause, settle);
    return promise;
  }

  function runCallback(callback: () => void): void {
    if (disposed) return; // dropped: dispose() stops everything that was pending
    try {
      callback();
    } catch (error) {
      report(error);
    }
  }

  function afterSettle(callback: () => void): void {
    if (typeof callback !== "function") throw new TypeError("afterSettle requires a callback function");
    if (disposed) return;
    // A reaction on the in-flight promise: it runs after the verdict, after this
    // module has cleared its state, and in registration order relative to every
    // other reaction (including an awaiting caller's continuation) on that promise.
    const target: Promise<unknown> = inFlight ?? Promise.resolve();
    void target.then(() => runCallback(callback));
  }

  return Object.freeze({
    release,
    isSettling: (): boolean => inFlight !== null,
    afterSettle,
    dispose(): void {
      disposed = true;
    },
  });
}
