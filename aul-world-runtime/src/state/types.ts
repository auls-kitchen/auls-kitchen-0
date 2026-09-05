// Domain state types. This module knows nothing about PixiJS, DOM, or Firebase.

export type ObjectClass = "Decorative" | "Reactive" | "Character" | "Portal" | "Event";

export type DepthLayer = "background" | "midground" | "foreground";

export interface WorldObject {
  id: string;
  class: ObjectClass;
  layer: DepthLayer;
  x: number;
  y: number;
  radius: number;
  colorHex: number;
  label: string;
}

export type CameraMode =
  | "WORLD_VIEW"
  | "AUL_FOCUS"
  | "CAT_FOCUS"
  | "OBJECT_FOCUS"
  | "MENU_FOCUS"
  | "EVENT_FOCUS";

export interface CameraState {
  mode: CameraMode;
  targetX: number;
  targetY: number;
  targetZoom: number;
}

export interface AulState {
  x: number;
  y: number;
  mood: "idle" | "happy" | "curious";
  interactionCount: number;
}

export interface CatState {
  x: number;
  y: number;
  asleep: boolean;
}

export interface CustomerState {
  present: boolean;
}

export interface OrderingState {
  // Ordering is a separate domain. World only knows a portal exists;
  // it never reaches into ordering's own state or Firestore.
  portalAvailable: boolean;
}

export interface SystemState {
  lastEventLog: string[];
  frame: number;
}

export interface WorldState {
  objects: WorldObject[];
  camera: CameraState;
  aul: AulState;
  cat: CatState;
  customer: CustomerState;
  ordering: OrderingState;
  system: SystemState;
}
