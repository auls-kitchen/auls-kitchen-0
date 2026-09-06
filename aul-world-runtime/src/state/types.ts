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

export type GreetingStatus = "idle" | "pending" | "success" | "failure";

// Effect-lifecycle status for the AWR-02 external-effects proof. This is
// still plain domain data — no PixiJS, no DOM, no reference to the mock
// service or the effect layer that produced it. requestId guards against
// a stale async result overwriting a newer request's outcome (see
// behavior/reducer.ts).
export interface AulGreetingState {
  requestId: number;
  status: GreetingStatus;
  message: string | null;
  error: string | null;
}

export interface AulState {
  x: number;
  y: number;
  mood: "idle" | "happy" | "curious";
  interactionCount: number;
  greeting: AulGreetingState;
}

export interface CatState {
  x: number;
  y: number;
  asleep: boolean;
}

export interface CustomerState {
  present: boolean;
}

export interface SystemState {
  lastEventLog: string[];
  frame: number;
}

// Which experience World is currently presenting. This is a WorldState
// (presentation) concern only — it says nothing about Ordering's own
// internal status (requested/ready/rejected), which lives entirely in
// ordering/types.ts, a separate module World does not import. World only
// ever learns Ordering's outcome via the semantic ORDERING_READY /
// ORDERING_REJECTED events (see behavior/reducer.ts and events/types.ts).
export type PresentationMode = "WORLD" | "ORDERING";

export interface WorldState {
  objects: WorldObject[];
  camera: CameraState;
  aul: AulState;
  cat: CatState;
  customer: CustomerState;
  system: SystemState;
  presentationMode: PresentationMode;
}
