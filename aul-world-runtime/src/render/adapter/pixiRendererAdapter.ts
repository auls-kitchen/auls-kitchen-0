// This is the ONLY module in the entire prototype permitted to import
// "pixi.js". Domain state, events, behavior, and world modules must
// never import this file's dependency, only this file's exported
// adapter interface (RendererAdapter). This is the enforced boundary:
//
//   Domain State -> Render State -> Renderer Adapter -> PixiJS
//
// The adapter does not decide business logic, does not own domain
// state, does not touch Firebase/Firestore, and does not compute
// anything financial. It only turns RenderState into pixels and turns
// raw pointer geometry into an object id handed back to the caller.

import { Application, Container, Graphics, type FederatedPointerEvent } from "pixi.js";
import type { RenderState } from "../renderState";
import type { DepthLayer } from "../../state/types";
import { descriptorKey } from "../../assets/assetBoundary";
import { VIEW_WIDTH, VIEW_HEIGHT, WORLD_CENTER_X, WORLD_CENTER_Y } from "../../state/worldConstants";

const PARALLAX_FACTOR: Record<DepthLayer, number> = {
  background: 0.25,
  midground: 0.6,
  foreground: 1.0,
};

const VIEW_W = VIEW_WIDTH;
const VIEW_H = VIEW_HEIGHT;

export interface RendererAdapter {
  init(container: HTMLElement): Promise<void>;
  render(state: RenderState): void;
  onObjectPointerDown(callback: (objectId: string, source: "canvas") => void): void;
  destroy(): void;
}

export function createPixiRendererAdapter(): RendererAdapter {
  let app: Application | null = null;
  let layers: Record<DepthLayer, Container> | null = null;
  let sprites = new Map<string, Graphics>();
  // Loaded-resource cache lives ONLY here, keyed by asset descriptor —
  // this is the "asset identifier -> loaded resource" boundary from
  // AWR-01 Section 15. Domain code never sees a Graphics/Texture.
  let shapeCache = new Map<string, Graphics>();
  let pointerCallback: ((objectId: string, source: "canvas") => void) | null = null;

  function getOrCreateShape(radius: number, colorHex: number): Graphics {
    const key = descriptorKey({ shape: "circle", radius, colorHex });
    const cached = shapeCache.get(key);
    if (cached) return cached.clone() as Graphics;
    const g = new Graphics().circle(0, 0, radius).fill(colorHex);
    shapeCache.set(key, g);
    return g.clone() as Graphics;
  }

  return {
    async init(container: HTMLElement): Promise<void> {
      app = new Application();
      await app.init({
        width: VIEW_W,
        height: VIEW_H,
        backgroundColor: 0x0e1420,
        antialias: true,
      });
      container.appendChild(app.canvas);

      const background = new Container();
      const midground = new Container();
      const foreground = new Container();
      app.stage.addChild(background, midground, foreground);
      layers = { background, midground, foreground };
    },

    render(state: RenderState): void {
      if (!app || !layers) return;

      for (const obj of state.objects) {
        let sprite = sprites.get(obj.id);
        if (!sprite) {
          sprite = getOrCreateShape(obj.radius, obj.colorHex);
          sprite.eventMode = "static";
          sprite.cursor = "pointer";
          sprite.on("pointerdown", (_e: FederatedPointerEvent) => {
            pointerCallback?.(obj.id, "canvas");
          });
          layers[obj.layer].addChild(sprite);
          sprites.set(obj.id, sprite);
        }
        // Recolor by clearing/redrawing rather than swapping textures —
        // acceptable for a handful of placeholder circles at prototype
        // scale; a production asset system would swap cached textures.
        sprite.clear().circle(0, 0, obj.radius).fill(obj.colorHex);
        if (obj.highlighted) {
          sprite.stroke({ width: 3, color: 0xffffff, alpha: 0.8 });
        }
        sprite.x = obj.x;
        sprite.y = obj.y;
      }

      // Camera transform: applied uniformly to each depth layer, scaled
      // by that layer's parallax factor. This is the ONLY place camera
      // math touches renderer containers — camera state itself
      // (render/camera state on WorldState) has no idea PixiJS exists.
      //
      // Convention: camera.x/y is the world point centered on screen;
      // "at rest" (WORLD_VIEW) that point is the canvas center, so
      // world objects render at exactly their authored coordinates
      // when the camera is not focused on anything. Object screen
      // position = centerX + (obj.x - camera.x) * effectiveZoom, which
      // for the foreground layer (parallax factor 1) is applied via
      // the layer's own transform rather than per-object math.
      const centerX = WORLD_CENTER_X;
      const centerY = WORLD_CENTER_Y;
      for (const layerName of Object.keys(layers) as DepthLayer[]) {
        const layer = layers[layerName];
        const pf = PARALLAX_FACTOR[layerName];
        const effectiveZoom = 1 + (state.camera.zoom - 1) * pf;
        layer.scale.set(effectiveZoom);
        layer.x = centerX - state.camera.x * effectiveZoom;
        layer.y = centerY - state.camera.y * effectiveZoom;
      }
    },

    onObjectPointerDown(callback) {
      pointerCallback = callback;
    },

    destroy(): void {
      app?.destroy(true, { children: true });
      app = null;
      layers = null;
      sprites = new Map();
      shapeCache = new Map();
    },
  };
}
