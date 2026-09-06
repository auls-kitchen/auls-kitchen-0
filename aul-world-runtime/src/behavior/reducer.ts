import type { WorldState, CameraMode } from "../state/types";
import type { AppEvent } from "../events/types";
import { WORLD_CENTER_X, WORLD_CENTER_Y } from "../state/worldConstants";

// The reducer is the ONLY place domain state is allowed to change.
// It knows nothing about PixiJS, canvas coordinates as pixels-on-screen,
// or DOM elements — it only knows semantic events and domain state.
// This is where "behavior" is decided; rendering never decides behavior.

function logEvent(state: WorldState, message: string): WorldState["system"] {
  const lastEventLog = [...state.system.lastEventLog, message].slice(-6);
  return { ...state.system, lastEventLog };
}

// Which camera mode a given world object grants when interacted with.
// (Only "Character"/"Portal" objects currently participate; see
// world/interactionContract.ts for the class-level intent gate that
// runs before this is ever consulted.)
const OBJECT_FOCUS_MODE: Record<string, CameraMode> = {
  aul: "AUL_FOCUS",
  "cat-1": "CAT_FOCUS",
  "portal-menu": "MENU_FOCUS",
};

// Single source of truth for "what does this camera mode look at".
// Used by BOTH the canvas object-interaction path and the DOM camera
// button path, so the two entry points can never drift apart — an
// earlier version computed focus targets only on the object-click path
// and left the DOM "Camera: X Focus" buttons unable to move the
// camera at all (see AWR-01 red-team findings).
function focusTargetForMode(mode: CameraMode, state: WorldState): { x: number; y: number; zoom: number } {
  switch (mode) {
    case "WORLD_VIEW":
      return { x: WORLD_CENTER_X, y: WORLD_CENTER_Y, zoom: 1 };
    case "AUL_FOCUS":
      return { x: state.aul.x, y: state.aul.y, zoom: 1.6 };
    case "CAT_FOCUS":
      return { x: state.cat.x, y: state.cat.y, zoom: 1.8 };
    case "MENU_FOCUS": {
      const portal = state.objects.find((o) => o.id === "portal-menu");
      return portal ? { x: portal.x, y: portal.y, zoom: 1.4 } : { x: WORLD_CENTER_X, y: WORLD_CENTER_Y, zoom: 1 };
    }
    case "OBJECT_FOCUS":
    case "EVENT_FOCUS":
      // Not driven by any control in this prototype; preserve current
      // target rather than snapping somewhere arbitrary.
      return { x: state.camera.targetX, y: state.camera.targetY, zoom: state.camera.targetZoom };
  }
}

export function reduce(state: WorldState, event: AppEvent): WorldState {
  switch (event.type) {
    case "OBJECT_INTERACTED": {
      const focusMode = OBJECT_FOCUS_MODE[event.objectId];
      const target = focusMode ? focusTargetForMode(focusMode, state) : null;
      const next: WorldState = {
        ...state,
        aul:
          event.objectId === "aul"
            ? { ...state.aul, mood: "happy", interactionCount: state.aul.interactionCount + 1 }
            : state.aul,
        cat:
          event.objectId === "cat-1"
            ? { ...state.cat, asleep: !state.cat.asleep }
            : state.cat,
        camera:
          focusMode && target
            ? { mode: focusMode, targetX: target.x, targetY: target.y, targetZoom: target.zoom }
            : state.camera,
      };
      return { ...next, system: logEvent(next, `OBJECT_INTERACTED(${event.objectId}) via ${event.source}`) };
    }
    case "CAMERA_FOCUS_REQUESTED": {
      const target = focusTargetForMode(event.mode, state);
      const next: WorldState = {
        ...state,
        camera: { mode: event.mode, targetX: target.x, targetY: target.y, targetZoom: target.zoom },
      };
      return { ...next, system: logEvent(next, `CAMERA_FOCUS_REQUESTED(${event.mode}) via ${event.source}`) };
    }
    case "DOM_PANEL_ACTION": {
      if (event.action === "GREET_AUL") {
        const next: WorldState = { ...state, aul: { ...state.aul, mood: "curious", interactionCount: state.aul.interactionCount + 1 } };
        return { ...next, system: logEvent(next, "DOM_PANEL_ACTION(GREET_AUL)") };
      }
      if (event.action === "RESET_WORLD") {
        const target = focusTargetForMode("WORLD_VIEW", state);
        const next: WorldState = {
          ...state,
          aul: { ...state.aul, mood: "idle" },
          camera: { mode: "WORLD_VIEW", targetX: target.x, targetY: target.y, targetZoom: target.zoom },
        };
        return { ...next, system: logEvent(next, "DOM_PANEL_ACTION(RESET_WORLD)") };
      }
      return state;
    }
    case "TICK": {
      return { ...state, system: { ...state.system, frame: state.system.frame + 1 } };
    }
    // AWR-02 external-effects proof. The reducer only ever sees the
    // REQUEST and the RESULT events — it never calls the mock service and
    // never awaits anything itself; the async work happens entirely in
    // effects/greetingEffect.ts, outside the reducer.
    case "AUL_GREETING_REQUESTED": {
      const requestId = state.aul.greeting.requestId + 1;
      const next: WorldState = {
        ...state,
        aul: { ...state.aul, greeting: { requestId, status: "pending", message: null, error: null } },
      };
      return { ...next, system: logEvent(next, `AUL_GREETING_REQUESTED(forceFailure=${event.forceFailure})`) };
    }
    case "AUL_GREETING_READY": {
      // Guard against a stale result: if a newer request has been issued
      // since this one was sent, this result no longer describes the
      // current pending request and must not overwrite it.
      if (event.requestId !== state.aul.greeting.requestId) {
        return { ...state, system: logEvent(state, `AUL_GREETING_READY ignored (stale requestId ${event.requestId})`) };
      }
      const next: WorldState = {
        ...state,
        aul: {
          ...state.aul,
          mood: "happy",
          greeting: { ...state.aul.greeting, status: "success", message: event.message, error: null },
        },
      };
      return { ...next, system: logEvent(next, `AUL_GREETING_READY("${event.message}")`) };
    }
    case "AUL_GREETING_FAILED": {
      if (event.requestId !== state.aul.greeting.requestId) {
        return { ...state, system: logEvent(state, `AUL_GREETING_FAILED ignored (stale requestId ${event.requestId})`) };
      }
      const next: WorldState = {
        ...state,
        aul: {
          ...state.aul,
          mood: "idle",
          greeting: { ...state.aul.greeting, status: "failure", message: null, error: event.reason },
        },
      };
      return { ...next, system: logEvent(next, `AUL_GREETING_FAILED("${event.reason}")`) };
    }
    default:
      return state;
  }
}
