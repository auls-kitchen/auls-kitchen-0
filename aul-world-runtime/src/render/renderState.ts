import type { WorldState, DepthLayer } from "../state/types";

// RenderState is a pure projection of WorldState. It contains only
// plain data (numbers/strings) — no PixiJS types appear here. The
// renderer adapter is the only consumer, and the only place that
// turns this into actual draw calls.

export interface RenderObject {
  id: string;
  layer: DepthLayer;
  x: number;
  y: number;
  radius: number;
  colorHex: number;
  highlighted: boolean;
}

export interface RenderCamera {
  x: number;
  y: number;
  zoom: number;
  mode: string;
}

export interface RenderState {
  objects: RenderObject[];
  camera: RenderCamera;
  hudText: string;
}

export function deriveRenderState(state: WorldState): RenderState {
  return {
    objects: state.objects.map((o) => ({
      id: o.id,
      layer: o.layer,
      x: o.id === "aul" ? state.aul.x : o.id === "cat-1" ? state.cat.x : o.x,
      y: o.id === "aul" ? state.aul.y : o.id === "cat-1" ? state.cat.y : o.y,
      radius: o.radius,
      colorHex:
        o.id === "aul" && state.aul.mood === "happy"
          ? 0xd98c3a
          : o.id === "aul" && state.aul.mood === "curious"
            ? 0x3aa0d9
            : o.id === "cat-1" && !state.cat.asleep
              ? 0xffffff
              : o.colorHex,
      highlighted: (o.id === "aul" && state.aul.mood !== "idle") || (o.id === "cat-1" && !state.cat.asleep),
    })),
    camera: {
      x: state.camera.targetX,
      y: state.camera.targetY,
      zoom: state.camera.targetZoom,
      mode: state.camera.mode,
    },
    hudText: `mode=${state.camera.mode} aul=${state.aul.mood} interactions=${state.aul.interactionCount} frame=${state.system.frame}`,
  };
}
