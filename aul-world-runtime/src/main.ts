import "./style.css";
import { createInitialState } from "./state/initialState";
import { reduce } from "./behavior/reducer";
import { deriveRenderState } from "./render/renderState";
import { createEventBus } from "./events/bus";
import { createPixiRendererAdapter } from "./render/adapter/pixiRendererAdapter";
import { createDomPanel } from "./dom/domPanel";
import { handleObjectHit } from "./world/hitTestPipeline";
import { attachResponsiveScale } from "./platform/resize";
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
  const bus = createEventBus();
  const renderer = createPixiRendererAdapter();
  await renderer.init(canvasWrap);
  const panel = createDomPanel(domWrap, bus);

  function renderAll() {
    const renderState = deriveRenderState(state);
    renderer.render(renderState);
    panel.update(renderState, state.system.lastEventLog);
  }

  // EVENT -> DISPATCH -> REDUCER -> NEW STATE -> DERIVED RENDER STATE -> CANVAS/DOM
  bus.subscribe((event) => {
    state = reduce(state, event);
    renderAll();
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
