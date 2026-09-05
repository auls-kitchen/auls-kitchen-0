// Semantic application events. These describe WHAT HAPPENED, never
// "move sprite" or any rendering-library concept.

export interface ObjectInteractedEvent {
  type: "OBJECT_INTERACTED";
  objectId: string;
  source: "canvas" | "dom";
}

export interface CameraFocusRequestedEvent {
  type: "CAMERA_FOCUS_REQUESTED";
  mode: import("../state/types").CameraMode;
  source: "canvas" | "dom";
}

export interface DomPanelActionEvent {
  type: "DOM_PANEL_ACTION";
  action: "GREET_AUL" | "RESET_WORLD";
}

export interface TickEvent {
  type: "TICK";
  deltaMs: number;
}

export type AppEvent =
  | ObjectInteractedEvent
  | CameraFocusRequestedEvent
  | DomPanelActionEvent
  | TickEvent;
