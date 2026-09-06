import "./style.css";
import { createInitialState } from "./state/initialState";
import { reduce } from "./behavior/reducer";
import { deriveRenderState } from "./render/renderState";
import { createEventBus } from "./events/bus";
import { createPixiRendererAdapter } from "./render/adapter/pixiRendererAdapter";
import { createCanvas2dTestAdapter } from "./render/adapter/canvas2dTestAdapter";
import { createDomPanel } from "./dom/domPanel";
import { handleObjectHit } from "./world/hitTestPipeline";
import { attachResponsiveScale } from "./platform/resize";
import { requestGreeting } from "./effects/greetingEffect";
import { createInitialOrderingState } from "./ordering/types";
import { reduceOrdering } from "./ordering/reducer";
import { decideOrderingOutcome } from "./ordering/orderingBoundary";
import { isDepthProofActive, createDepthProofState, renderDepthProofOverlay } from "./render/depthProof";
import type { WorldState } from "./state/types";

async function bootstrap() {
  const root = document.getElementById("app")!;
  root.innerHTML = `
    <div class="awr-layout">
      <div class="awr-canvas-wrap" id="awr-canvas-wrap"></div>
      <div class="awr-dom-wrap" id="awr-dom-wrap"></div>
    </div>
  `;
  const canvasWrap = document.getElementById("awr-canvas-wrap")!;
  const domWrap = document.getElementById("awr-dom-wrap")!;

  // AWR-05 Gate 4: ?depth-proof=1 opt-in only. Without it, the normal
  // AWR-04 scene (createInitialState()) is unchanged and unaffected.
  const depthProofActive = isDepthProofActive();
  let state: WorldState = depthProofActive ? createDepthProofState() : createInitialState();
  let orderingState = createInitialOrderingState();
  const bus = createEventBus();
  // AWR-05 / C5: ?renderer=canvas2d is opt-in only, proving the renderer
  // adapter boundary is swappable. Normal boot (no param) is unaffected
  // and always uses createPixiRendererAdapter().
  const useCanvas2d = new URLSearchParams(window.location.search).get("renderer") === "canvas2d";
  const renderer = useCanvas2d ? createCanvas2dTestAdapter() : createPixiRendererAdapter();
  await renderer.init(canvasWrap);
  const panel = createDomPanel(domWrap, bus);
  if (depthProofActive) {
    renderDepthProofOverlay(root);
  }

  function renderAll() {
    const renderState = deriveRenderState(state, orderingState);
    renderer.render(renderState);
    panel.update(renderState, state.system.lastEventLog);
  }

  // EVENT -> DISPATCH -> REDUCER(S) -> NEW STATE -> DERIVED RENDER STATE -> CANVAS/DOM
  //
  // AWR-03 adds a second, independent reducer (reduceOrdering) alongside
  // World's own `reduce()`. Both run for every event on the same shared
  // bus and each owns only its own state slice (WorldState vs
  // OrderingState) — neither reducer imports the other's state module.
  // This is still exactly two plain function calls, not a
  // combineReducers-style framework.
  //
  // AWR-02's effect-router pattern is reused unchanged for AWR-03's
  // World -> Ordering boundary: seeing MENU_INTENT, main.ts calls the
  // Ordering-side boundary decision (ordering/orderingBoundary.ts, pure,
  // synchronous — no external system or async boundary is required or
  // permitted for this proof) and emits whatever it returns back onto
  // the same bus, re-entering this exact subscriber.
  bus.subscribe((event) => {
    state = reduce(state, event);
    orderingState = reduceOrdering(orderingState, event);
    renderAll();
    if (event.type === "AUL_GREETING_REQUESTED") {
      requestGreeting(bus, { forceFailure: event.forceFailure, requestId: state.aul.greeting.requestId });
    }
    if (event.type === "MENU_INTENT") {
      bus.emit(decideOrderingOutcome(event));
    }
  });

  // CUSTOMER INPUT -> HIT TEST (delegated to renderer) -> OBJECT ID -> ...
  renderer.onObjectPointerDown((objectId, source) => {
    handleObjectHit(state, objectId, source, bus);
  });

  attachResponsiveScale(canvasWrap, 640);

  renderAll();

  // Small TICK loop only to prove the state/event path also carries
  // time-based events without becoming a general game loop framework.
  let last = performance.now();
  function tick(now: number) {
    const deltaMs = now - last;
    last = now;
    bus.emit({ type: "TICK", deltaMs });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

bootstrap().catch((err) => {
  console.error("AWR-01 bootstrap failed:", err);
  const root = document.getElementById("app")!;
  root.innerHTML = `<pre style="color:#f66">AWR-01 failed to start: ${String(err)}</pre>`;
});
