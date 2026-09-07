import { describe, it, expect } from "vitest";
import { deriveRenderState } from "../../src/render/renderState";
import { createInitialState } from "../../src/state/initialState";
import { createInitialOrderingState } from "../../src/ordering/types";
import type { WorldState } from "../../src/state/types";

// C6 Phase 2: pure-logic regression tests for the RenderState
// projection (deriveRenderState). Proves the projection is stable and
// correct independently of any renderer — no PixiJS, no Canvas2D
// import anywhere in this file.

describe("deriveRenderState: HUD text composition", () => {
  it("composes the exact HUD text fields used by the DOM panel", () => {
    const state = createInitialState();
    const ordering = createInitialOrderingState();
    const render = deriveRenderState(state, ordering);
    expect(render.hudText).toBe(
      `mode=${state.camera.mode} aul=${state.aul.mood} interactions=${state.aul.interactionCount} frame=${state.system.frame} greeting=${state.aul.greeting.status} presentation=${state.presentationMode} ordering=${ordering.status}`,
    );
  });
});

describe("deriveRenderState: object projection", () => {
  it("projects Aul's screen position from live aul state, not the authored object entry", () => {
    const state = createInitialState();
    // Deliberately desynchronize the authored "aul" object entry from
    // state.aul to prove the projection reads state.aul.x/y, not
    // objects[].x/y.
    const desynced: WorldState = {
      ...state,
      objects: state.objects.map((o) => (o.id === "aul" ? { ...o, x: 999, y: 999 } : o)),
    };
    const render = deriveRenderState(desynced, createInitialOrderingState());
    const aulObj = render.objects.find((o) => o.id === "aul")!;
    expect(aulObj.x).toBe(state.aul.x);
    expect(aulObj.y).toBe(state.aul.y);
  });

  it("projects the cat's screen position from live cat state, not the authored object entry", () => {
    const state = createInitialState();
    const desynced: WorldState = {
      ...state,
      objects: state.objects.map((o) => (o.id === "cat-1" ? { ...o, x: 1, y: 1 } : o)),
    };
    const render = deriveRenderState(desynced, createInitialOrderingState());
    const catObj = render.objects.find((o) => o.id === "cat-1")!;
    expect(catObj.x).toBe(state.cat.x);
    expect(catObj.y).toBe(state.cat.y);
  });

  it("projects every other object's position unchanged from its authored entry", () => {
    const state = createInitialState();
    const render = deriveRenderState(state, createInitialOrderingState());
    const hill = render.objects.find((o) => o.id === "bg-hill-1")!;
    const authored = state.objects.find((o) => o.id === "bg-hill-1")!;
    expect(hill.x).toBe(authored.x);
    expect(hill.y).toBe(authored.y);
    expect(hill.z).toBe(authored.z);
  });
});

describe("deriveRenderState: highlight derivation", () => {
  it("Aul is not highlighted while idle", () => {
    const state = createInitialState();
    const render = deriveRenderState(state, createInitialOrderingState());
    expect(render.objects.find((o) => o.id === "aul")!.highlighted).toBe(false);
  });

  it("Aul is highlighted and recolored when mood is happy", () => {
    const state: WorldState = { ...createInitialState(), aul: { ...createInitialState().aul, mood: "happy" } };
    const render = deriveRenderState(state, createInitialOrderingState());
    const aulObj = render.objects.find((o) => o.id === "aul")!;
    expect(aulObj.highlighted).toBe(true);
    expect(aulObj.colorHex).toBe(0xd98c3a);
  });

  it("Aul is recolored (but a different color) when mood is curious", () => {
    const state: WorldState = { ...createInitialState(), aul: { ...createInitialState().aul, mood: "curious" } };
    const render = deriveRenderState(state, createInitialOrderingState());
    const aulObj = render.objects.find((o) => o.id === "aul")!;
    expect(aulObj.highlighted).toBe(true);
    expect(aulObj.colorHex).toBe(0x3aa0d9);
  });

  it("the cat is not highlighted while asleep (the initial state)", () => {
    const state = createInitialState();
    const render = deriveRenderState(state, createInitialOrderingState());
    expect(render.objects.find((o) => o.id === "cat-1")!.highlighted).toBe(false);
  });

  it("the cat is highlighted and recolored white when awake", () => {
    const state: WorldState = { ...createInitialState(), cat: { ...createInitialState().cat, asleep: false } };
    const render = deriveRenderState(state, createInitialOrderingState());
    const catObj = render.objects.find((o) => o.id === "cat-1")!;
    expect(catObj.highlighted).toBe(true);
    expect(catObj.colorHex).toBe(0xffffff);
  });
});

describe("deriveRenderState: camera projection", () => {
  it("maps CameraState's target fields into RenderCamera", () => {
    const state: WorldState = {
      ...createInitialState(),
      camera: { mode: "AUL_FOCUS", targetX: 111, targetY: 222, targetZoom: 1.6 },
    };
    const render = deriveRenderState(state, createInitialOrderingState());
    expect(render.camera).toEqual({ x: 111, y: 222, zoom: 1.6, mode: "AUL_FOCUS" });
  });
});

describe("deriveRenderState: Ordering projection", () => {
  it("maps OrderingState's status and rejectionReason into RenderOrdering", () => {
    const state = createInitialState();
    const ordering = { status: "rejected" as const, rejectionReason: "test_rejection" };
    const render = deriveRenderState(state, ordering);
    expect(render.ordering).toEqual({ status: "rejected", rejectionReason: "test_rejection" });
    expect(render.hudText).toContain("ordering=rejected");
  });

  it("maps presentationMode independently of ordering status", () => {
    const state: WorldState = { ...createInitialState(), presentationMode: "ORDERING" };
    const render = deriveRenderState(state, createInitialOrderingState());
    expect(render.presentationMode).toBe("ORDERING");
  });
});
