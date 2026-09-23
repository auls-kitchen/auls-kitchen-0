// Composition root (U3): AWR World -> Composition -> Experience -> Kiosk snapshot.
//
// This is the ONE place that holds both the AWR wiring and the Kiosk host. It
// reproduces AWR's own bootstrap wiring from AWR's public modules (B1 "Option
// A") WITHOUT importing or modifying aul-world-runtime/src/main.ts, and without
// adding any factory or export to AWR. Deliberately NOT imported from AWR:
// main.ts, domPanel, canvas2dTestAdapter, orderingAlt, depthProof,
// mockGreetingService, greetingEffect (all proof/test artifacts), and none of
// AWR's URL-parameter switches (?renderer, ?ordering, ?depth-proof) are honored.
//
// What crosses each boundary:
//   AWR -> here          : the AWR event bus and WorldState, both owned here
//   here -> Experience   : narrow ports only (see createExperienceLifecycle)
//   here -> Kiosk Domain : the KioskHostPort below - getSnapshot, subscribe,
//                          getBootstrapStatus, ONE beginCustomerSession() at
//                          mount, and ONE releaseCustomerContext(), which is
//                          handed to the context-transitions coordinator as a
//                          plain function and is the only Domain release seam.
//                          No other Domain method is ever named.
//
// Ownership: the Composition owns the lifecycle of everything it creates.
// mountAulWorld() returns its handle SYNCHRONOUSLY; `ready` settles once the
// renderer has initialized and everything is wired. dispose() tears it down in
// strict reverse order of creation, is idempotent, and is safe to call at any
// moment - including before `ready`, while the renderer is still starting.

import { reduce } from "../../../aul-world-runtime/src/behavior/reducer.ts";
import { createEventBus } from "../../../aul-world-runtime/src/events/bus.ts";
import type { AppEvent } from "../../../aul-world-runtime/src/events/types.ts";
import { reduceOrdering } from "../../../aul-world-runtime/src/ordering/reducer.ts";
import { decideOrderingOutcome } from "../../../aul-world-runtime/src/ordering/orderingBoundary.ts";
import { createInitialOrderingState } from "../../../aul-world-runtime/src/ordering/types.ts";
import { attachResponsiveScale } from "../../../aul-world-runtime/src/platform/resize.ts";
import { createPixiRendererAdapter } from "../../../aul-world-runtime/src/render/adapter/pixiRendererAdapter.ts";
import { deriveRenderState } from "../../../aul-world-runtime/src/render/renderState.ts";
import { createInitialState } from "../../../aul-world-runtime/src/state/initialState.ts";
import type { WorldState } from "../../../aul-world-runtime/src/state/types.ts";
import { handleObjectHit } from "../../../aul-world-runtime/src/world/hitTestPipeline.ts";

import type { Clock, Scheduler, SnapshotReadPort, ExperienceSnapshotView } from "../contracts.ts";
import { createExperienceLifecycle } from "../experience/createExperienceLifecycle.ts";
import type { ExperienceLifecycle } from "../experience/createExperienceLifecycle.ts";
import type { InteractiveTargetPredicate } from "../experience/customerInput.ts";
import type { InteractionPhase, InteractionThresholds, RestingPhase } from "../experience/interactionContext.ts";
import { classifyPending, releasePlanFor, routeCustomerReturn } from "../experience/pendingTicket.ts";
import type { ReleasePlan, WakeDecision } from "../experience/pendingTicket.ts";
import { createMonotonicClock, createTimeoutScheduler } from "../experience/silenceTimer.ts";
import { decideTakeover } from "../experience/takeoverPolicy.ts";
import type { TakeoverDecision } from "../experience/takeoverPolicy.ts";
import { createExperienceShell } from "../shell/experienceShell.ts";
import { createContextBoundary } from "./contextBoundary.ts";
import type { BoundaryToken } from "./contextBoundary.ts";
import { createContextTransitions } from "./contextTransitions.ts";
import type { ReleaseCause, ReleaseVerdict } from "./contextTransitions.ts";

// The whole Domain surface the Composition may touch, structurally typed so
// nothing here imports Kiosk code. The Kiosk Host returned by
// createBrowserKiosk() satisfies it; a caller may pass a narrower wrapper.
export interface KioskHostPort {
  readonly orchestrator: {
    getSnapshot(): ExperienceSnapshotView;
    subscribe(listener: (event: { readonly type: string }) => void): () => void;
    // The Domain's guarded customer-context release. Its result is opaque here.
    releaseCustomerContext(): Promise<unknown>;
  };
  beginCustomerSession(): Promise<{ readonly status: string }>;
  getBootstrapStatus(): string;
}

export interface MountAulWorldOptions {
  readonly container: HTMLElement;
  readonly host: KioskHostPort;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  readonly thresholds?: InteractionThresholds;
  readonly isInteractiveTarget?: InteractiveTargetPredicate;
  // Presentation/observability hooks. They carry no business data and are
  // never handed any Domain object.
  readonly onPhase?: (phase: InteractionPhase) => void;
  // Every route decision: once per wake from Habitat, and once more if a
  // customer who arrived before the Domain was ready is re-routed on readiness.
  readonly onWake?: (decision: WakeDecision) => void;
  // Every takeover decision a customer's Home/X activation reaches (Slice 2A:
  // the decision is only RECORDED here; nothing is released, cleared, or routed
  // because of it). One of five constant names, no business data.
  readonly onHomeDecision?: (decision: TakeoverDecision) => void;
  readonly onError?: (error: unknown) => void;
}

export interface AulWorldHandle {
  // Settles when the World is rendered and the Experience is listening. Rejects
  // if the renderer cannot start (the Composition has already disposed itself).
  readonly ready: Promise<void>;
  dispose(): void;
  getPhase(): RestingPhase;
  // Settles once the Domain's boot has finished (READY or FAILED). The World
  // is already alive before this; a Domain that is slow or failing never
  // blocks or breaks it.
  readonly domainSettled: Promise<void>;
}

const CANVAS_NATIVE_WIDTH = 640;

export function mountAulWorld(options: MountAulWorldOptions): AulWorldHandle {
  const { container, host } = options;
  const doc = container.ownerDocument;

  let disposed = false;
  const cleanups: Array<() => void> = [];

  function report(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // The error hook must never break the Composition.
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Strict reverse order of creation: stop input and timers first, remove
    // the DOM last.
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        report(error);
      }
    }
  }

  // --- Layout: one root element inside the caller's container ---------------
  const root = doc.createElement("div");
  root.setAttribute("data-aul-world", "");
  root.style.cssText = "display:flex;flex-wrap:wrap;gap:16px;padding:16px;";
  const canvasWrap = doc.createElement("div");
  canvasWrap.setAttribute("data-aul-canvas", "");
  canvasWrap.style.cssText = `width:${CANVAS_NATIVE_WIDTH}px;height:400px;overflow:hidden;`;
  root.appendChild(canvasWrap);
  container.appendChild(root);
  cleanups.push(() => root.remove());

  // --- AWR: state, bus, renderer (same wiring as AWR's own bootstrap) --------
  let state: WorldState = createInitialState();
  let orderingState = createInitialOrderingState();
  const bus = createEventBus();
  const renderer = createPixiRendererAdapter();

  const rendererReady = renderer.init(canvasWrap);
  // destroy() is chained after init settles, so disposing mid-init is safe.
  cleanups.push(() => {
    void rendererReady.then(
      () => renderer.destroy(),
      () => {},
    );
  });

  let lifecycle: ExperienceLifecycle | null = null;

  let settleDomain: () => void = () => {};
  const domainSettled = new Promise<void>((resolve) => {
    settleDomain = resolve;
  });
  // Disposing before the Domain settles must not leave anyone waiting forever.
  cleanups.push(() => settleDomain());

  const ready = (async (): Promise<void> => {
    try {
      await rendererReady;
    } catch (error) {
      dispose();
      throw error;
    }

    // dispose() may have run while the renderer was starting. Everything below
    // is synchronous, so nothing can dispose in the middle of the wiring.
    if (disposed) return;

    // The read-only Domain access the Experience is allowed.
    const snapshots: SnapshotReadPort = { getSnapshot: () => host.orchestrator.getSnapshot() };

    // --- Experience shell (DOM, inside the same page as the canvas) ----------
    const shell = createExperienceShell(root, {
      domainStatus: host.getBootstrapStatus(),
      // The customer's own Menu action: the same MENU_INTENT a canvas portal tap emits.
      // D2 Step 2: gated by the same Menu/Product takeover check as the canvas Portal -
      // see handleMenuInteraction below.
      onMenu: () => handleMenuInteraction(() => bus.emit({ type: "MENU_INTENT", source: "dom", forceReject: false })),
      // Home/X: the lifecycle latched the phase before the customer's press; the
      // shell only calls this for a trusted click that has one.
      consumeGesture: () => lifecycle?.consumeGesture() ?? null,
      // Slice 2A decision boundary. It reads ONE snapshot, applies the pure
      // takeover policy, and records the decision. It performs no release, no
      // Domain write, no routing and no presentation change of its own.
      onHome: (request) => {
        let snapshot: ExperienceSnapshotView | null = null;
        try {
          snapshot = snapshots.getSnapshot();
        } catch (error) {
          report(error);
          // Fail closed: an unreadable Domain is NOT_READY, never "no ticket".
        }
        const decision = decideTakeover({ phaseBefore: request.phaseBefore, snapshot });
        try {
          options.onHomeDecision?.(decision);
        } catch (error) {
          report(error);
        }
        // S4c: acting on the decision - NOT_READY and NO_TAKEOVER stay a pure no-op (nothing
        // releasable, nothing protected to show differently). BLOCKED_UNKNOWN presents the
        // neutral protected view WITHOUT ever beginning a new epoch or touching the Domain
        // (locked): it bypasses reconcileContext entirely, unlike every releasing path. Only
        // an ACCEPTED takeover reconciles for real, through the exact same machinery a wake
        // already uses - same epoch guard, same single-flight coordinator, same gated reset.
        if (decision === "BLOCKED_UNKNOWN") {
          presentImmediate(routeCustomerReturn(snapshot));
        } else if (decision === "TAKEOVER_ACTIVE_CART" || decision === "TAKEOVER_CONFIRMATION") {
          reconcileContext(routeCustomerReturn(snapshot), snapshot, "TAKEOVER", (plan) => plan === "RELEASE");
        }
      },
    });
    cleanups.push(() => shell.dispose());

    function renderAll(): void {
      const renderState = deriveRenderState(state, orderingState);
      renderer.render(renderState);
      shell.setWorld({
        presentationMode: renderState.presentationMode,
        camera: renderState.camera.mode,
        aulMood: state.aul.mood,
        aulInteractions: state.aul.interactionCount,
        frame: state.system.frame,
      });
    }

    // EVENT -> DISPATCH -> REDUCER(S) -> STATE -> RENDER (AWR's own dispatcher,
    // minus the greeting effect, which only AWR's test panel could trigger).
    const unsubscribeBus = bus.subscribe((event: AppEvent) => {
      state = reduce(state, event);
      orderingState = reduceOrdering(orderingState, event);
      // Secondary, input-order protection only (S4b): a customer-caused World event
      // vetoes an in-flight reconciliation's optional World reset. It never authorizes
      // presentation or a release, and never revokes an epoch's authority - see
      // contextBoundary.ts and its worldQuiet()/isCurrent() distinction.
      if (event.type === "OBJECT_INTERACTED" || event.type === "CAMERA_FOCUS_REQUESTED" || event.type === "MENU_INTENT") {
        boundary.noteWorldTouch();
      }
      renderAll();
      if (event.type === "MENU_INTENT") {
        bus.emit(decideOrderingOutcome(event));
      }
    });
    cleanups.push(unsubscribeBus);

    // CUSTOMER INPUT -> HIT TEST (renderer) -> OBJECT ID -> intent -> event.
    // Always reads the latest state. D2 Step 2 (corrected scope): ONLY a Portal
    // hit goes through the SAME Menu/Product takeover gate the shell Menu
    // button uses, BEFORE the exact, unmodified handleObjectHit(...) call below
    // ever runs. Character/Reactive/Decorative/Event are explicitly OUT of D2:
    // no Owner-locked record ever named them as takeover triggers, and routing
    // them through decideTakeover's any-phase BLOCKED_UNKNOWN/NOT_READY
    // semantics would suppress ordinary world interaction that P1/P2, BD2/BD3,
    // R6 and W1 already establish as unconditional - so they always take the
    // exact, unmodified handleObjectHit(...) call directly, exactly as before
    // this slice. The class check reads only the object's own `class` field
    // already on `state` - it never imports or calls AWR's intentFor, and never
    // re-derives which event handleObjectHit will emit; that classification
    // stays entirely inside hitTestPipeline.ts, untouched.
    renderer.onObjectPointerDown((objectId, source) => {
      const obj = state.objects.find((candidate) => candidate.id === objectId);
      if (obj !== undefined && obj.class === "Portal") {
        handleMenuInteraction(() => handleObjectHit(state, objectId, source, bus));
        return;
      }
      handleObjectHit(state, objectId, source, bus);
    });

    cleanups.push(attachResponsiveScale(canvasWrap, CANVAS_NATIVE_WIDTH));

    // AWR's frame loop. It ticks the World; it is NOT the interaction clock and
    // never reaches the Experience lifecycle. Cancelled on dispose.
    let running = true;
    let frameHandle = 0;
    let lastFrameAt: number | null = null;
    const tick = (now: number): void => {
      if (!running) return;
      const deltaMs = lastFrameAt === null ? 0 : now - lastFrameAt;
      lastFrameAt = now;
      bus.emit({ type: "TICK", deltaMs });
      frameHandle = requestAnimationFrame(tick);
    };
    cleanups.push(() => {
      running = false;
      cancelAnimationFrame(frameHandle);
    });

    renderAll();

    // --- Context boundary: the stale-context guard (S4b) ---------------------
    // Generation is the SOLE authority for whether a settled release may still
    // affect presentation or the World: isCurrent()/own()/settle() all key on it
    // alone. `touch` is secondary and only ever vetoes the OPTIONAL World reset
    // below (worldQuiet) - it can never authorize a presentation or a release,
    // and never makes an epoch stale (see contextBoundary.ts; not modified here).
    //
    // `currentToken` is the epoch a release started NOW would belong to. It only
    // ever advances at a customer arrival (a wake, or the hydration reboot
    // boundary) - never at expiry itself, which always acts under whichever
    // epoch is already current.
    const boundary = createContextBoundary<ReleaseVerdict>();
    let currentToken: BoundaryToken = boundary.beginEpoch();
    cleanups.push(() => boundary.dispose());

    // The ONE place RESET_WORLD/RETURN_TO_WORLD are ever emitted: only from an
    // authorized, still-current boundary continuation, and only for the exact
    // FRESH verdict of a context this Composition itself released. Sequential
    // and synchronous (the bus is not re-entrant here: this runs from a Promise
    // continuation, never from inside another bus.emit's own subscriber call).
    function resetWorld(): void {
      bus.emit({ type: "DOM_PANEL_ACTION", action: "RESET_WORLD" });
      bus.emit({ type: "RETURN_TO_WORLD", source: "dom" });
    }

    function isReleaseSettled(event: unknown): event is { readonly type: "RELEASE_SETTLED"; readonly verdict: ReleaseVerdict } {
      return typeof event === "object" && event !== null && (event as { readonly type?: unknown }).type === "RELEASE_SETTLED";
    }

    // --- Context transitions: the ONE Domain release seam --------------------
    // The Domain's guarded release is handed to the coordinator as a plain
    // function; this is the only place it is named. Created BEFORE the lifecycle,
    // so on dispose (reverse order) the timer stops first and the coordinator
    // is disposed after it. onTransition feeds the boundary's settlement -
    // dropped by the coordinator itself once disposed, so a late outcome after
    // dispose is discarded there (contextTransitions.ts is unmodified).
    const transitions = createContextTransitions({
      release: () => host.orchestrator.releaseCustomerContext(),
      onTransition: (event) => {
        if (isReleaseSettled(event)) boundary.settle(event.verdict);
      },
      onError: report,
    });
    cleanups.push(() => transitions.dispose());

    // Presents a decision through the existing shell + external hook, with no
    // release involved (the fail-closed default, or nothing was releasable).
    function presentImmediate(decision: WakeDecision): void {
      shell.setWake(decision);
      try {
        options.onWake?.(decision);
      } catch (error) {
        report(error);
      }
    }

    // Presents the FINAL decision for a release this Composition owns, once its
    // verdict is known. Only ever called from inside boundary.own()'s registered
    // continuation, itself only invoked by settle() while the token is current -
    // so no staleness check is needed here; it is already guaranteed.
    function presentFinal(token: BoundaryToken, snapshot: ExperienceSnapshotView | null, verdict: ReleaseVerdict): void {
      presentImmediate(routeCustomerReturn(snapshot, verdict));
      if (verdict === "FRESH" && boundary.worldQuiet(token)) resetWorld();
    }

    // Runs a caller-supplied continuation exactly when a release this
    // Composition owns has settled FRESH - independent of worldQuiet (a
    // customer's touch may still veto the optional World reset without ever
    // vetoing this). Only ever called from inside boundary.own()'s registered
    // continuation, itself only invoked by settle() while the token is
    // current, so no staleness check is needed here; it is already
    // guaranteed, and settle() invokes that continuation at most once - so
    // this runs at most once too. The callback is external (a future D2
    // caller's), so it is isolated the same way onWake/onHomeDecision already are.
    function runFresh(verdict: ReleaseVerdict, onFresh: (() => void) | undefined): void {
      if (verdict !== "FRESH" || !onFresh) return;
      try {
        onFresh();
      } catch (error) {
        report(error);
      }
    }

    // The one reconciliation entry point shared by a wake and the reboot boundary
    // (S4b). `eligible` decides which release plans this caller may reconcile
    // (a wake reconciles any releasable context; the reboot boundary reconciles
    // CONFIRMATION only - see their call sites). Never joins another owner's
    // release, never consumes another owner's verdict, never retries: if
    // own() fails (the epoch already has an owner), it fails closed to an
    // immediate, verdict-less presentation.
    //
    // `onFresh` is an optional, additive continuation (D2 Step 1): when given,
    // it runs once a release THIS reconciliation itself owns has settled FRESH
    // for the still-current token - never on UNAVAILABLE, never on a stale or
    // contested-away token, and never tied to worldQuiet/resetWorld. It rides
    // the exact same own()/settle() closure presentFinal already uses, so it
    // inherits the same at-most-once, current-token-only guarantee. No caller
    // today passes it; existing callers are unaffected.
    function reconcileContext(
      decision: WakeDecision,
      snapshot: ExperienceSnapshotView | null,
      cause: ReleaseCause,
      eligible: (plan: ReleasePlan, snapshot: ExperienceSnapshotView | null) => boolean,
      onFresh?: () => void,
    ): void {
      const token = boundary.beginEpoch();
      currentToken = token;
      const plan = releasePlanFor(snapshot);
      if (!eligible(plan, snapshot)) {
        presentImmediate(decision);
        return;
      }
      if (!transitions.isSettling()) {
        if (boundary.own(token, (verdict) => {
          presentFinal(token, snapshot, verdict);
          runFresh(verdict, onFresh);
        })) {
          void transitions.release(cause);
        } else {
          presentImmediate(decision);
        }
        return;
      }
      // Contested: an earlier release is still in flight. Its verdict is never this
      // customer's truth - wait for the coordinator to free up (no verdict from this),
      // then read ONE fresh snapshot and decide entirely from that (the one, bounded,
      // extra read the contested path is allowed).
      transitions.afterSettle(() => {
        if (!boundary.isCurrent(token)) return; // superseded by a still-newer arrival
        let freshSnapshot: ExperienceSnapshotView | null = null;
        try {
          freshSnapshot = snapshots.getSnapshot();
        } catch (error) {
          report(error);
        }
        const freshDecision = routeCustomerReturn(freshSnapshot);
        if (!eligible(releasePlanFor(freshSnapshot), freshSnapshot)) {
          presentImmediate(freshDecision);
          return;
        }
        if (boundary.own(token, (verdict) => {
          presentFinal(token, freshSnapshot, verdict);
          runFresh(verdict, onFresh);
        })) {
          void transitions.release(cause);
        } else {
          presentImmediate(freshDecision);
        }
      });
    }

    // D2 Step 2: the Menu/Product first-press takeover gate. Shared by the shell
    // Menu button and the canvas Menu Portal ONLY (see renderer.onObjectPointerDown
    // above) - the ONE place this decision is made, so there is exactly one
    // Menu/Product business path, not two. Character/Reactive are deliberately
    // NOT routed here (Owner-corrected scope: no prior lock ever named them, and
    // decideTakeover's any-phase BLOCKED_UNKNOWN/NOT_READY would otherwise
    // suppress ordinary world interaction P1/P2/BD2/BD3/R6/W1 already establish
    // as unconditional). `action` is always the caller's own, unmodified
    // interaction (a bus.emit or a handleObjectHit call); this gate never
    // re-derives or duplicates it.
    //
    // No fresh gesture (the common case: not the first press since the window
    // last restarted) forwards `action` immediately, exactly as before this
    // slice. A fresh gesture is evaluated with the same, unmodified
    // decideTakeover policy Home/X already uses: NO_TAKEOVER forwards `action`
    // immediately; NOT_READY and BLOCKED_UNKNOWN both present the existing
    // customer-return view for the snapshot (waiting / protected, decided by
    // routeCustomerReturn itself) and suppress `action` entirely; an accepted
    // takeover reconciles for real through the exact same reconcileContext a
    // wake/reboot/Home takeover already uses, and `action` is forwarded only
    // once that reconciliation's OWN release settles FRESH - via the additive
    // onFresh continuation from D2 Step 1, never tied to worldQuiet, never a
    // second callback/settlement primitive/verdict/reset path. A verdict other
    // than FRESH (UNAVAILABLE) presents the existing unavailable view and never
    // forwards `action`, exactly like Home's own takeover today.
    function handleMenuInteraction(action: () => void): void {
      const gesture = lifecycle?.consumeGesture() ?? null;
      if (gesture === null) {
        action();
        return;
      }
      let snapshot: ExperienceSnapshotView | null = null;
      try {
        snapshot = snapshots.getSnapshot();
      } catch (error) {
        report(error);
        // Fail closed: an unreadable Domain is NOT_READY, never "no ticket".
      }
      const decision = decideTakeover({ phaseBefore: gesture.phaseBefore, snapshot });
      if (decision === "NO_TAKEOVER") {
        action();
        return;
      }
      if (decision === "BLOCKED_UNKNOWN" || decision === "NOT_READY") {
        presentImmediate(routeCustomerReturn(snapshot));
        return;
      }
      reconcileContext(routeCustomerReturn(snapshot), snapshot, "TAKEOVER", (plan) => plan === "RELEASE", action);
    }

    // CONTEXT_EXPIRED: read ONE snapshot and, only for a releasable customer
    // context, start one guarded release under the CURRENT epoch. UNKNOWN /
    // AWAITING_OUTCOME (PROTECTED), an idle session, and anything unreadable
    // never reach the Domain. A stale epoch's release still runs to completion
    // in the Domain, but its verdict can never emit a World reset once a newer
    // customer's arrival has made it stale (S4b; see contextBoundary.ts).
    function handleContextExpired(): void {
      let snapshot: ExperienceSnapshotView | null = null;
      try {
        snapshot = snapshots.getSnapshot();
      } catch (error) {
        report(error);
        // Fail closed: an unreadable Domain is NOT_READY, and NOT_READY never releases.
      }
      if (releasePlanFor(snapshot) !== "RELEASE") return;
      const token = currentToken;
      const owned = boundary.own(token, (verdict) => {
        if (verdict === "FRESH" && boundary.worldQuiet(token)) resetWorld();
      });
      if (!owned) return; // fail closed: another continuation already owns this epoch
      void transitions.release("EXPIRY");
    }

    // --- Experience lifecycle: the only timer, given only narrow ports -------
    const experience = createExperienceLifecycle({
      clock: options.clock ?? createMonotonicClock(),
      scheduler: options.scheduler ?? createTimeoutScheduler(),
      inputTarget: root,
      snapshots,
      // The lifecycle's one AWR output. AWR events carry only "canvas"|"dom" as
      // source; nothing in this Composition treats a bus event as customer
      // input (input is read only from DOM listeners on `root`), so this cannot
      // wake the Experience.
      presentation: { returnToWorld: () => bus.emit({ type: "RETURN_TO_WORLD", source: "dom" }) },
      world: { isOrdering: () => state.presentationMode === "ORDERING" },
      thresholds: options.thresholds,
      isInteractiveTarget: options.isInteractiveTarget,
      onPhase: (phase) => {
        shell.setPhase(phase);
        options.onPhase?.(phase);
      },
      // A wake begins a new customer epoch (S4b) before anything else: a stale
      // release still settling from whoever left can never mutate this decision
      // or the World once this line has run. Reconciles any releasable context
      // (WAKE_RECONCILE); business reconciliation lives here, not in the lifecycle.
      onWake: (decision, snapshot) => {
        reconcileContext(decision, snapshot, "WAKE_RECONCILE", (plan) => plan === "RELEASE");
      },
      onContextExpired: handleContextExpired,
      onError: report,
    });
    lifecycle = experience;
    cleanups.push(() => experience.dispose());

    // --- Kiosk Domain: subscribe FIRST, then begin (Host's required order) ----
    const unsubscribeDomain = host.orchestrator.subscribe((event) => shell.setDomainEvent(event.type));
    cleanups.push(unsubscribeDomain);

    // Start listening for customers (and ticking the World) before the Domain boots.
    experience.start();
    frameHandle = requestAnimationFrame(tick);

    // A customer who arrived before the Domain was ready is routed again, once,
    // now that a snapshot can be read. This is also the ONLY reboot boundary
    // (S4b): it never fires unless a waiter is actually pending (no unconditional
    // boot read is ever added), and it reconciles a hydrated CONFIRMATION only -
    // never a hypothetical ACTIVE cart (the Runtime never persists one). UNKNOWN /
    // AWAITING_OUTCOME stay PROTECTED, exactly as releasePlanFor already refuses.
    function reroutePendingWaiter(): void {
      if (shell.getState().view !== "waiting" || experience.getPhase() === "HABITAT_IDLE") return;
      let snapshot: ExperienceSnapshotView | null;
      try {
        snapshot = snapshots.getSnapshot();
      } catch (error) {
        report(error);
        return;
      }
      reconcileContext(routeCustomerReturn(snapshot), snapshot, "REBOOT_BOUNDARY", (plan, s) => plan === "RELEASE" && classifyPending(s) === "CONFIRMATION");
    }

    host.beginCustomerSession().then(
      (result) => {
        if (!disposed) {
          shell.setDomainStatus(host.getBootstrapStatus());
          if (result.status === "FAILED") report(new Error("Kiosk Domain bootstrap failed"));
          reroutePendingWaiter();
        }
        settleDomain();
      },
      (error: unknown) => {
        if (!disposed) {
          shell.setDomainStatus(host.getBootstrapStatus());
          report(error);
        }
        settleDomain();
      },
    );
  })();

  return Object.freeze({
    ready,
    dispose,
    getPhase: (): RestingPhase => lifecycle?.getPhase() ?? "HABITAT_IDLE",
    domainSettled,
  });
}
