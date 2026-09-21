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
//                          getBootstrapStatus, and ONE beginCustomerSession()
//                          at mount. No other Domain method is ever named.
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
import { routeCustomerReturn } from "../experience/pendingTicket.ts";
import type { WakeDecision } from "../experience/pendingTicket.ts";
import { createMonotonicClock, createTimeoutScheduler } from "../experience/silenceTimer.ts";
import { decideTakeover } from "../experience/takeoverPolicy.ts";
import type { TakeoverDecision } from "../experience/takeoverPolicy.ts";
import { createExperienceShell } from "../shell/experienceShell.ts";

// The whole Domain surface the Composition may touch, structurally typed so
// nothing here imports Kiosk code. The Kiosk Host returned by
// createBrowserKiosk() satisfies it; a caller may pass a narrower wrapper.
export interface KioskHostPort {
  readonly orchestrator: {
    getSnapshot(): ExperienceSnapshotView;
    subscribe(listener: (event: { readonly type: string }) => void): () => void;
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
      onMenu: () => bus.emit({ type: "MENU_INTENT", source: "dom", forceReject: false }),
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
      renderAll();
      if (event.type === "MENU_INTENT") {
        bus.emit(decideOrderingOutcome(event));
      }
    });
    cleanups.push(unsubscribeBus);

    // CUSTOMER INPUT -> HIT TEST (renderer) -> OBJECT ID -> intent -> event.
    // Always reads the latest state.
    renderer.onObjectPointerDown((objectId, source) => {
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
      onWake: (decision) => {
        shell.setWake(decision);
        options.onWake?.(decision);
      },
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
    // now that a snapshot can be read. Read-only: it only re-runs the pure router.
    function reroutePendingWaiter(): void {
      if (shell.getState().view !== "waiting" || experience.getPhase() === "HABITAT_IDLE") return;
      let decision: WakeDecision;
      try {
        decision = routeCustomerReturn(snapshots.getSnapshot());
      } catch (error) {
        report(error);
        return;
      }
      shell.setWake(decision);
      try {
        options.onWake?.(decision);
      } catch (error) {
        report(error);
      }
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
