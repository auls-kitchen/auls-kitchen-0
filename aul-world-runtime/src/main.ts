import "./style.css";
import { createInitialState } from "./state/initialState";
import { reduce } from "./behavior/reducer";
import { deriveRenderState } from "./render/renderState";
import { createEventBus } from "./events/bus";
import { createPixiRendererAdapter } from "./render/adapter/pixiRendererAdapter";
import { createDomPanel } from "./dom/domPanel";
import { handleObjectHit } from "./world/hitTestPipeline";
import { attachResponsiveScale } from "./platform/resize";
import { requestGreeting } from "./effects/greetingEffect";
import { createInitialOrderingState } from "./ordering/types";
import { reduceOrdering } from "./ordering/reducer";
import { decideOrderingOutcome } from "./ordering/orderingBoundary";
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

  let state: WorldState = createInitialState();
  let orderingState = createInitialOrderingState();
  const bus = createEventBus();
  const renderer = createPixiRendererAdapter();
  await renderer.init(canvasWrap);
  const panel = createDomPanel(domWrap, bus);

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
