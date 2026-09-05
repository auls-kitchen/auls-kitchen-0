import type { WorldState } from "./types";
import { WORLD_CENTER_X, WORLD_CENTER_Y } from "./worldConstants";

// Placeholder objects only. No production Aul artwork, no production
// cats, no production menu images — plain colored circles standing in
// for future sprites.
export function createInitialState(): WorldState {
  return {
    objects: [
      { id: "bg-hill-1", class: "Decorative", layer: "background", x: 120, y: 140, radius: 60, colorHex: 0x2c3a4a, label: "hill" },
      { id: "bg-hill-2", class: "Decorative", layer: "background", x: 420, y: 120, radius: 50, colorHex: 0x2c3a4a, label: "hill" },
      { id: "mid-stall", class: "Reactive", layer: "midground", x: 260, y: 260, radius: 40, colorHex: 0x5a4630, label: "stall" },
      { id: "portal-menu", class: "Portal", layer: "midground", x: 460, y: 250, radius: 30, colorHex: 0xd98c3a, label: "menu portal" },
      { id: "cat-1", class: "Character", layer: "foreground", x: 340, y: 320, radius: 18, colorHex: 0xcccccc, label: "cat" },
      { id: "aul", class: "Character", layer: "foreground", x: 200, y: 310, radius: 26, colorHex: 0x1a1a1a, label: "Aul (placeholder)" },
    ],
    // "At rest" (WORLD_VIEW) camera target is the canvas center — see
    // render/adapter/pixiRendererAdapter.ts for why this makes objects
    // render at their authored coordinates when not focused.
    camera: { mode: "WORLD_VIEW", targetX: WORLD_CENTER_X, targetY: WORLD_CENTER_Y, targetZoom: 1 },
    aul: { x: 200, y: 310, mood: "idle", interactionCount: 0 },
    cat: { x: 340, y: 320, asleep: true },
    customer: { present: false },
    ordering: { portalAvailable: true },
    system: { lastEventLog: [], frame: 0 },
  };
}
