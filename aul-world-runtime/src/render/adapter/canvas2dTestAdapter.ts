// AWR-05 / C5: temporary, disposable proof adapter. It exists to
// empirically demonstrate that the AWR-01 boundary
// (Domain State -> RenderState -> Renderer Adapter -> Renderer
// Technology) is a real replacement seam, not an accidental one, by
// implementing the same renderer-adapter shape used by
// pixiRendererAdapter.ts with a completely different, non-PixiJS
// rendering technology (native Canvas 2D).
//
// Deliberate isolation choices (disclosed, not silent):
// - This file imports NOTHING from state/*, ordering/*, behavior/*, or
//   world/*, and does not import pixiRendererAdapter.ts or "pixi.js" —
//   verified by grep as part of the C5 boundary-isolation gate. The
//   only cross-module import is the plain-data `RenderState` shape
//   from ../renderState, exactly as authorized.
// - VIEW_WIDTH/VIEW_HEIGHT/WORLD_CENTER_X/WORLD_CENTER_Y and the
//   parallax-factor thresholds are intentionally duplicated here
//   (matching the values already used by state/worldConstants.ts and
//   state/depth.ts) rather than imported, purely to keep this file at
//   zero state/* imports for the C5 proof. This is proof-scoped
//   duplication, not a proposal to remove the single source of truth
//   those domain modules provide for normal (PixiJS) operation.
// - The RendererAdapter shape below is a structural (duck-typed) match
//   to the interface already exported by pixiRendererAdapter.ts — it is
//   not a new/parallel abstraction, just declared locally so this file
//   never needs to import anything from that module.

import type { RenderState } from "../renderState";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 400;
const WORLD_CENTER_X = VIEW_WIDTH / 2;
const WORLD_CENTER_Y = VIEW_HEIGHT / 2;

function canvas2dParallaxFactor(z: number): number {
  if (z < 20) return 0.25;
  if (z < 40) return 0.6;
  return 1.0;
}

function colorHexToCss(colorHex: number): string {
  return `#${colorHex.toString(16).padStart(6, "0")}`;
}

interface RendererAdapter {
  init(container: HTMLElement): Promise<void>;
  render(state: RenderState): void;
  onObjectPointerDown(callback: (objectId: string, source: "canvas") => void): void;
  destroy(): void;
}

interface ScreenObject {
  id: string;
  screenX: number;
  screenY: number;
  screenRadius: number;
}

export function createCanvas2dTestAdapter(): RendererAdapter {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let screenObjects: ScreenObject[] = [];
  let pointerCallback: ((objectId: string, source: "canvas") => void) | null = null;

  function handlePointerDown(e: PointerEvent): void {
    if (!canvas || !pointerCallback) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const localX = (e.clientX - rect.left) * scaleX;
    const localY = (e.clientY - rect.top) * scaleY;

    // Topmost (highest z, drawn last) object wins on overlap — search in
    // reverse draw order, mirroring how a real 2D-painter's-algorithm
    // renderer resolves hit-testing on overlapping shapes.
    for (let i = screenObjects.length - 1; i >= 0; i--) {
      const obj = screenObjects[i];
      const dx = localX - obj.screenX;
      const dy = localY - obj.screenY;
      if (Math.sqrt(dx * dx + dy * dy) <= obj.screenRadius) {
        pointerCallback(obj.id, "canvas");
        return;
      }
    }
  }

  return {
    async init(container: HTMLElement): Promise<void> {
      canvas = document.createElement("canvas");
      canvas.width = VIEW_WIDTH;
      canvas.height = VIEW_HEIGHT;
      ctx = canvas.getContext("2d");
      canvas.addEventListener("pointerdown", handlePointerDown);
      container.appendChild(canvas);
    },

    render(state: RenderState): void {
      if (!canvas || !ctx) return;

      ctx.fillStyle = "#0e1420";
      ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

      // Draw order comes SOLELY from the object's own numeric depth,
      // via a local ascending sort of a copy of state.objects — never
      // id, class, y position, or original array/insertion order. This
      // proves the numeric depth model itself does not depend on
      // PixiJS's zIndex/sortChildren() mechanism.
      const sorted = [...state.objects].sort((a, b) => a.z - b.z);
      const nextScreenObjects: ScreenObject[] = [];

      for (const obj of sorted) {
        const pf = canvas2dParallaxFactor(obj.z);
        const effectiveZoom = 1 + (state.camera.zoom - 1) * pf;
        const screenX = WORLD_CENTER_X + (obj.x - state.camera.x) * effectiveZoom;
        const screenY = WORLD_CENTER_Y + (obj.y - state.camera.y) * effectiveZoom;
        const screenRadius = obj.radius * effectiveZoom;

        ctx.beginPath();
        ctx.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);
        ctx.fillStyle = colorHexToCss(obj.colorHex);
        ctx.fill();
        if (obj.highlighted) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255,255,255,0.8)";
          ctx.stroke();
        }

        nextScreenObjects.push({ id: obj.id, screenX, screenY, screenRadius });
      }

      screenObjects = nextScreenObjects;
    },

    onObjectPointerDown(callback) {
      pointerCallback = callback;
    },

    destroy(): void {
      canvas?.removeEventListener("pointerdown", handlePointerDown);
      canvas?.remove();
      canvas = null;
      ctx = null;
      screenObjects = [];
      pointerCallback = null;
    },
  };
}
