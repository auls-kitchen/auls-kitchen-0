// AWR-05 Gate 4: C4.4 depth proof scene.
//
// This module supplies WorldObject data ONLY — it never touches PixiJS,
// never sorts anything, and never draws anything itself. It goes through
// the exact same pipeline as every other scene:
//
//   WorldState -> RenderState -> PixiRendererAdapter -> Pixi
//
// The adapter (unchanged from Gate 3) is the only place that reads
// `sprite.zIndex = obj.z` and calls `world.sortChildren()`. If that
// adapter logic were wrong and fell back to array/insertion order
// instead, THIS scene is deliberately built so the visual result would
// be obviously broken (see PROOF_OBJECTS below).
import type { WorldObject, WorldState } from "../state/types";
import { asDepthZ } from "../state/depth";
import { createInitialState } from "../state/initialState";

const PROOF_CENTER_X = 320;
const PROOF_CENTER_Y = 200;

// One object per required depth level, all sharing the same x/y so they
// visually overlap, with radius DECREASING as Z increases (Z0 = biggest,
// Z60 = smallest). Correct zIndex-based draw order renders Z0 first
// (bottom) up through Z60 last (top), producing seven concentric rings
// — a "bullseye" with Z60's color as the small solid center and Z0's
// color visible only as the outermost ring.
//
// The array below is intentionally listed Z60 -> Z0 (descending), the
// OPPOSITE of ascending Z. If the renderer only followed array/insertion
// order (i.e. ignored `obj.z` entirely), Z0 — the LARGEST circle — would
// be the last one drawn and would completely blot out every smaller
// circle beneath it: the proof would visibly collapse into one solid
// Z0-colored disc with no rings at all. Array order is not the
// authority; only a correct zIndex/sortChildren implementation produces
// the full seven-ring bullseye.
const PROOF_OBJECTS: WorldObject[] = [
  { id: "proof-60", class: "Event", z: asDepthZ(60), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 30, colorHex: 0xe63946, label: "Z60" },
  { id: "proof-50", class: "Event", z: asDepthZ(50), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 40, colorHex: 0xf3722c, label: "Z50" },
  { id: "proof-40", class: "Event", z: asDepthZ(40), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 50, colorHex: 0xf9c74f, label: "Z40" },
  { id: "proof-30", class: "Event", z: asDepthZ(30), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 60, colorHex: 0x90be6d, label: "Z30" },
  { id: "proof-20", class: "Event", z: asDepthZ(20), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 70, colorHex: 0x43aa8b, label: "Z20" },
  { id: "proof-10", class: "Event", z: asDepthZ(10), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 80, colorHex: 0x577590, label: "Z10" },
  { id: "proof-0", class: "Event", z: asDepthZ(0), x: PROOF_CENTER_X, y: PROOF_CENTER_Y, radius: 90, colorHex: 0x277da1, label: "Z0" },
];

export function isDepthProofActive(): boolean {
  return new URLSearchParams(window.location.search).get("depth-proof") === "1";
}

// Starts from the normal AWR-04 initial state (unchanged, still the
// default whenever ?depth-proof=1 is absent — see main.ts) and swaps
// only `objects`, per the "minimum change to a normal WorldState"
// instruction. Camera/aul/cat/customer/system/presentationMode are all
// left exactly as createInitialState() produces them.
export function createDepthProofState(): WorldState {
  return {
    ...createInitialState(),
    objects: PROOF_OBJECTS,
  };
}

// Minimal static debug overlay — plain DOM text, no framework, no
// interactivity, created once. This is a hardcoded, independent display
// list (front-to-back, Z60 to Z0) for human reference only — it is NOT
// derived from PROOF_OBJECTS and performs no sort of any kind, so it
// cannot be mistaken for participating in draw-order logic.
export function renderDepthProofOverlay(root: HTMLElement): void {
  const pre = document.createElement("pre");
  pre.style.cssText =
    "position:fixed;top:8px;right:8px;margin:0;padding:8px 12px;" +
    "background:#0e1420;color:#e6e6e6;border:1px solid #2c3a4a;" +
    "border-radius:6px;font-size:12px;z-index:9999;";
  pre.textContent = ["AWR-05 DEPTH PROOF", "", "Z60", "Z50", "Z40", "Z30", "Z20", "Z10", "Z0"].join("\n");
  root.appendChild(pre);
}
