import { describe, it, expect } from "vitest";
import { reduce } from "../../src/behavior/reducer";
import { createInitialState } from "../../src/state/initialState";
import { WORLD_CENTER_X, WORLD_CENTER_Y } from "../../src/state/worldConstants";
import type { WorldState } from "../../src/state/types";
import type { AppEvent } from "../../src/events/types";

// C6 Phase 2: pure-logic regression tests for behavior/reducer.ts,
// derived from the already-validated AWR-01/02/03 assertions (manual
// R1-R7 gates and prior checkpoints). Behavior/invariants only — no
// PixiJS/Canvas2D, no DOM, no Firebase.

function baseState(): WorldState {
  return createInitialState();
}

describe("reduce: OBJECT_INTERACTED", () => {
  it("Aul interaction sets mood happy, increments interactionCount, and focuses camera on Aul", () => {
    const state = baseState();
    const next = reduce(state, { type: "OBJECT_INTERACTED", objectId: "aul", source: "canvas" });
    expect(next.aul.mood).toBe("happy");
    expect(next.aul.interactionCount).toBe(state.aul.interactionCount + 1);
    expect(next.camera.mode).toBe("AUL_FOCUS");
    expect(next.camera.targetX).toBe(state.aul.x);
    expect(next.camera.targetY).toBe(state.aul.y);
  });

  it("Cat interaction toggles asleep and focuses camera on the cat", () => {
    const state = baseState();
    const next = reduce(state, { type: "OBJECT_INTERACTED", objectId: "cat-1", source: "canvas" });
    expect(next.cat.asleep).toBe(!state.cat.asleep);
    expect(next.camera.mode).toBe("CAT_FOCUS");
    expect(next.camera.targetX).toBe(state.cat.x);
    expect(next.camera.targetY).toBe(state.cat.y);
  });

  it("interacting with an object that has no focus mapping leaves camera unchanged", () => {
    const state = baseState();
    const next = reduce(state, { type: "OBJECT_INTERACTED", objectId: "bg-hill-1", source: "canvas" });
    expect(next.camera).toEqual(state.camera);
  });

  it("is suppressed while presentationMode is ORDERING (no domain-state change besides the log)", () => {
    const state: WorldState = { ...baseState(), presentationMode: "ORDERING" };
    const next = reduce(state, { type: "OBJECT_INTERACTED", objectId: "aul", source: "canvas" });
    expect(next.aul).toEqual(state.aul);
    expect(next.cat).toEqual(state.cat);
    expect(next.camera).toEqual(state.camera);
    expect(next.presentationMode).toBe("ORDERING");
  });
});

describe("reduce: CAMERA_FOCUS_REQUESTED", () => {
  it("moves the camera to the requested mode's target", () => {
    const state = baseState();
    const next = reduce(state, { type: "CAMERA_FOCUS_REQUESTED", mode: "CAT_FOCUS", source: "dom" });
    expect(next.camera.mode).toBe("CAT_FOCUS");
    expect(next.camera.targetX).toBe(state.cat.x);
    expect(next.camera.targetY).toBe(state.cat.y);
  });

  it("WORLD_VIEW targets the world center at zoom 1", () => {
    const state = baseState();
    const next = reduce(state, { type: "CAMERA_FOCUS_REQUESTED", mode: "WORLD_VIEW", source: "dom" });
    expect(next.camera).toEqual({ mode: "WORLD_VIEW", targetX: WORLD_CENTER_X, targetY: WORLD_CENTER_Y, targetZoom: 1 });
  });

  it("is suppressed while presentationMode is ORDERING", () => {
    const state: WorldState = { ...baseState(), presentationMode: "ORDERING" };
    const next = reduce(state, { type: "CAMERA_FOCUS_REQUESTED", mode: "AUL_FOCUS", source: "dom" });
    expect(next.camera).toEqual(state.camera);
  });
});

describe("reduce: DOM_PANEL_ACTION", () => {
  it("GREET_AUL sets mood curious and increments interactionCount", () => {
    const state = baseState();
    const next = reduce(state, { type: "DOM_PANEL_ACTION", action: "GREET_AUL" });
    expect(next.aul.mood).toBe("curious");
    expect(next.aul.interactionCount).toBe(state.aul.interactionCount + 1);
  });

  it("RESET_WORLD returns Aul to idle and the camera to WORLD_VIEW", () => {
    const state = reduce(baseState(), { type: "OBJECT_INTERACTED", objectId: "aul", source: "canvas" });
    const next = reduce(state, { type: "DOM_PANEL_ACTION", action: "RESET_WORLD" });
    expect(next.aul.mood).toBe("idle");
    expect(next.camera.mode).toBe("WORLD_VIEW");
  });
});

describe("reduce: TICK", () => {
  it("increments the frame counter and changes nothing else", () => {
    const state = baseState();
    const next = reduce(state, { type: "TICK", deltaMs: 16 });
    expect(next.system.frame).toBe(state.system.frame + 1);
    expect(next.aul).toEqual(state.aul);
    expect(next.cat).toEqual(state.cat);
    expect(next.camera).toEqual(state.camera);
  });
});

describe("reduce: AUL_GREETING_* flow", () => {
  it("REQUESTED increments requestId and sets status pending", () => {
    const state = baseState();
    const next = reduce(state, { type: "AUL_GREETING_REQUESTED", forceFailure: false, source: "dom" });
    expect(next.aul.greeting.requestId).toBe(state.aul.greeting.requestId + 1);
    expect(next.aul.greeting.status).toBe("pending");
  });

  it("READY for the current request sets status success, mood happy, and carries a message (not asserted verbatim)", () => {
    const requested = reduce(baseState(), { type: "AUL_GREETING_REQUESTED", forceFailure: false, source: "dom" });
    const currentRequestId = requested.aul.greeting.requestId;
    const next = reduce(requested, { type: "AUL_GREETING_READY", requestId: currentRequestId, message: "any greeting text" });
    expect(next.aul.greeting.status).toBe("success");
    expect(next.aul.mood).toBe("happy");
    expect(typeof next.aul.greeting.message).toBe("string");
    expect(next.aul.greeting.message).not.toBeNull();
  });

  it("FAILED for the current request sets status failure, mood idle, and carries an error reason", () => {
    const requested = reduce(baseState(), { type: "AUL_GREETING_REQUESTED", forceFailure: true, source: "dom" });
    const currentRequestId = requested.aul.greeting.requestId;
    const next = reduce(requested, { type: "AUL_GREETING_FAILED", requestId: currentRequestId, reason: "simulated failure" });
    expect(next.aul.greeting.status).toBe("failure");
    expect(next.aul.mood).toBe("idle");
    expect(next.aul.greeting.error).toBe("simulated failure");
  });

  it("a stale READY result (older requestId) does not overwrite the newer pending request", () => {
    const firstRequested = reduce(baseState(), { type: "AUL_GREETING_REQUESTED", forceFailure: false, source: "dom" });
    const staleRequestId = firstRequested.aul.greeting.requestId;
    const secondRequested = reduce(firstRequested, { type: "AUL_GREETING_REQUESTED", forceFailure: false, source: "dom" });
    expect(secondRequested.aul.greeting.requestId).toBe(staleRequestId + 1);

    const next = reduce(secondRequested, { type: "AUL_GREETING_READY", requestId: staleRequestId, message: "stale message" });
    // The newer pending request must be untouched by the stale result.
    expect(next.aul.greeting).toEqual(secondRequested.aul.greeting);
    expect(next.aul.greeting.status).toBe("pending");
  });

  it("a stale FAILED result (older requestId) does not overwrite the newer pending request", () => {
    const firstRequested = reduce(baseState(), { type: "AUL_GREETING_REQUESTED", forceFailure: true, source: "dom" });
    const staleRequestId = firstRequested.aul.greeting.requestId;
    const secondRequested = reduce(firstRequested, { type: "AUL_GREETING_REQUESTED", forceFailure: false, source: "dom" });

    const next = reduce(secondRequested, { type: "AUL_GREETING_FAILED", requestId: staleRequestId, reason: "stale failure" });
    expect(next.aul.greeting).toEqual(secondRequested.aul.greeting);
    expect(next.aul.greeting.status).toBe("pending");
  });
});

describe("reduce: World <-> Ordering boundary events", () => {
  it("MENU_INTENT changes no domain-state field besides the event log", () => {
    const state = baseState();
    const next = reduce(state, { type: "MENU_INTENT", source: "canvas", forceReject: false });
    expect(next.presentationMode).toBe(state.presentationMode);
    expect(next.camera).toEqual(state.camera);
    expect(next.aul).toEqual(state.aul);
    expect(next.cat).toEqual(state.cat);
  });

  it("ORDERING_READY switches presentationMode to ORDERING and focuses the camera on the menu portal", () => {
    const state = baseState();
    const portal = state.objects.find((o) => o.id === "menu_portal")!;
    const next = reduce(state, { type: "ORDERING_READY" });
    expect(next.presentationMode).toBe("ORDERING");
    expect(next.camera.mode).toBe("MENU_FOCUS");
    expect(next.camera.targetX).toBe(portal.x);
    expect(next.camera.targetY).toBe(portal.y);
  });

  it("ORDERING_REJECTED leaves presentationMode and camera untouched", () => {
    const state = baseState();
    const next = reduce(state, { type: "ORDERING_REJECTED", reason: "test_rejection" });
    expect(next.presentationMode).toBe(state.presentationMode);
    expect(next.camera).toEqual(state.camera);
  });

  it("RETURN_TO_WORLD switches presentationMode back to WORLD and camera back to WORLD_VIEW", () => {
    const ordering = reduce(baseState(), { type: "ORDERING_READY" });
    const next = reduce(ordering, { type: "RETURN_TO_WORLD", source: "dom" });
    expect(next.presentationMode).toBe("WORLD");
    expect(next.camera.mode).toBe("WORLD_VIEW");
  });
});

describe("reduce: unknown event types", () => {
  it("returns the exact same state reference for an event type it does not own", () => {
    const state = baseState();
    const next = reduce(state, { type: "ORDERING_READY_UNRELATED" } as unknown as AppEvent);
    expect(next).toBe(state);
  });
});
