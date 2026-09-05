import type { EventBus } from "../events/bus";
import type { RenderState } from "../render/renderState";

// Plain DOM/CSS test panel. Proves DOM and Canvas coexist as
// independent layers: this module never touches PixiJS, and the
// renderer adapter never touches the DOM tree below. The only thing
// connecting them is the semantic event bus and the derived RenderState
// snapshot, both plain data.
export function createDomPanel(container: HTMLElement, bus: EventBus) {
  const panel = document.createElement("div");
  panel.className = "awr-dom-panel";
  panel.innerHTML = `
    <h2>DOM Test Panel</h2>
    <p class="awr-hint">Domain/Canvas boundary proof — this panel is plain DOM, independent of the PixiJS canvas.</p>
    <div class="awr-row">
      <button data-action="GREET_AUL">Greet Aul (DOM -&gt; state -&gt; Canvas)</button>
      <button data-action="RESET_WORLD">Reset World</button>
    </div>
    <div class="awr-row">
      <button data-camera="WORLD_VIEW">Camera: World View</button>
      <button data-camera="AUL_FOCUS">Camera: Aul Focus</button>
    </div>
    <pre class="awr-status" id="awr-status">(waiting for first render)</pre>
    <p class="awr-hint">Click Aul or the cat on the canvas to see this panel update (Canvas -&gt; state -&gt; DOM).</p>
    <ul class="awr-log" id="awr-log"></ul>
  `;
  container.appendChild(panel);

  panel.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      bus.emit({ type: "DOM_PANEL_ACTION", action: btn.dataset.action as "GREET_AUL" | "RESET_WORLD" });
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("button[data-camera]").forEach((btn) => {
    btn.addEventListener("click", () => {
      bus.emit({
        type: "CAMERA_FOCUS_REQUESTED",
        mode: btn.dataset.camera as "WORLD_VIEW" | "AUL_FOCUS",
        source: "dom",
      });
    });
  });

  const statusEl = panel.querySelector<HTMLPreElement>("#awr-status")!;
  const logEl = panel.querySelector<HTMLUListElement>("#awr-log")!;

  return {
    update(renderState: RenderState, eventLog: string[]): void {
      statusEl.textContent = renderState.hudText;
      logEl.innerHTML = eventLog.map((line) => `<li>${line}</li>`).join("");
    },
  };
}
