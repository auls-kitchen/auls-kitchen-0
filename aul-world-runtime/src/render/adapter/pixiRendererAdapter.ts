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
import { depthParallaxFactor } from "../../state/depth";
import { descriptorKey } from "../../assets/assetBoundary";
import { VIEW_WIDTH, VIEW_HEIGHT, WORLD_CENTER_X, WORLD_CENTER_Y } from "../../state/worldConstants";

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
  // AWR-05 Gate 3: a single world Container replaces the three fixed
  // background/midground/foreground Containers. Z0-Z60 is a numeric
  // depth space, not a set of renderer layers — every object is a direct
  // child of this one Container, and `sortableChildren` lets Pixi order
  // them by `zIndex` (set from the object's own numeric `z` every
  // render) instead of by insertion order.
  let world: Container | null = null;
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

      world = new Container();
      world.sortableChildren = true;
      app.stage.addChild(world);
    },

    render(state: RenderState): void {
      if (!app || !world) return;

      for (const obj of state.objects) {
        let sprite = sprites.get(obj.id);
        if (!sprite) {
          sprite = getOrCreateShape(obj.radius, obj.colorHex);
          sprite.eventMode = "static";
          sprite.cursor = "pointer";
          sprite.on("pointerdown", (_e: FederatedPointerEvent) => {
            pointerCallback?.(obj.id, "canvas");
          });
          world.addChild(sprite);
          sprites.set(obj.id, sprite);
        }
        // Recolor by clearing/redrawing rather than swapping textures —
        // acceptable for a handful of placeholder circles at prototype
        // scale; a production asset system would swap cached textures.
        sprite.clear().circle(0, 0, obj.radius).fill(obj.colorHex);
        if (obj.highlighted) {
          sprite.stroke({ width: 3, color: 0xffffff, alpha: 0.8 });
        }

        // Draw order comes SOLELY from the object's own numeric depth —
        // never id, class, y position, array index, insertion order, or
        // a layer name. `world.sortChildren()` below applies this.
        sprite.zIndex = obj.z;

        // Camera transform: computed per-object now, since parallax is a
        // continuous function of numeric depth (depthParallaxFactor)
        // rather than a fixed per-container value. `world` itself stays
        // at identity transform (position 0,0, scale 1) — every sprite's
        // own x/y/scale already encodes the full camera-adjusted screen
        // position, using exactly the AWR-04 formula, just evaluated
        // per-object instead of per-layer-container.
        const pf = depthParallaxFactor(obj.z);
        const effectiveZoom = 1 + (state.camera.zoom - 1) * pf;
        sprite.x = WORLD_CENTER_X + (obj.x - state.camera.x) * effectiveZoom;
        sprite.y = WORLD_CENTER_Y + (obj.y - state.camera.y) * effectiveZoom;
        sprite.scale.set(effectiveZoom);
      }

      world.sortChildren();
    },

    onObjectPointerDown(callback) {
      pointerCallback = callback;
    },

    destroy(): void {
      app?.destroy(true, { children: true });
      app = null;
      world = null;
      sprites = new Map();
      shapeCache = new Map();
    },
  };
}
