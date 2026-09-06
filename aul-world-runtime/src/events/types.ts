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

// AWR-02 external-effects proof. AUL_GREETING_REQUESTED is a genuine
// effect request (routed to the mock external service in main.ts, see
// effects/greetingEffect.ts) — distinct from AWR-01's synchronous
// DOM_PANEL_ACTION("GREET_AUL"), which is left unchanged.
export interface AulGreetingRequestedEvent {
  type: "AUL_GREETING_REQUESTED";
  forceFailure: boolean;
  source: "dom";
}

// Result events. Only ever emitted by the effect layer after the mock
// service settles — never emitted directly by DOM or canvas code.
export interface AulGreetingReadyEvent {
  type: "AUL_GREETING_READY";
  requestId: number;
  message: string;
}

export interface AulGreetingFailedEvent {
  type: "AUL_GREETING_FAILED";
  requestId: number;
  reason: string;
}

export type AppEvent =
  | ObjectInteractedEvent
  | CameraFocusRequestedEvent
  | DomPanelActionEvent
  | TickEvent
  | AulGreetingRequestedEvent
  | AulGreetingReadyEvent
  | AulGreetingFailedEvent;
