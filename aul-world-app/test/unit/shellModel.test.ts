// U3 tests for src/shell/shellModel.ts - the pure mapping behind the shell's
// data-* hooks. No DOM needed; the DOM writer itself is proven in the browser e2e.

import test from "node:test";
import assert from "node:assert/strict";

import { initialShellState, shellAttributes, viewForRoute, withHabitat, withWake } from "../../src/shell/shellModel.ts";
import type { ShellState } from "../../src/shell/shellModel.ts";

test("S1. each wake route maps to exactly one view", () => {
  assert.equal(viewForRoute("DISCOVER_MENU"), "discover");
  assert.equal(viewForRoute("OWNERSHIP_CONFIRMATION"), "ownership");
  assert.equal(viewForRoute("WAIT_NOT_READY"), "waiting");
});

test("S2. the initial state is Habitat with nothing routed", () => {
  const state = initialShellState("BOOTSTRAPPING");
  assert.equal(state.phase, "HABITAT_IDLE");
  assert.equal(state.view, "habitat");
  assert.equal(state.wakeRoute, "");
  assert.equal(state.pending, "");
  assert.equal(state.domainStatus, "BOOTSTRAPPING");
});

test("S3. a wake records the route and pending kind and switches the view", () => {
  const woken = withWake(initialShellState("READY"), { route: "OWNERSHIP_CONFIRMATION", pending: "UNRESOLVED" });
  assert.equal(woken.view, "ownership");
  assert.equal(woken.wakeRoute, "OWNERSHIP_CONFIRMATION");
  assert.equal(woken.pending, "UNRESOLVED");
});

test("S4. entering Habitat resets only the Experience view state, nothing else", () => {
  const busy: ShellState = {
    ...withWake(initialShellState("READY"), { route: "OWNERSHIP_CONFIRMATION", pending: "ACTIVE_CART" }),
    phase: "RELEASED",
    domainLastEvent: "SESSION_STARTED",
    world: { presentationMode: "ORDERING", camera: "MENU_FOCUS", aulMood: "happy", aulInteractions: 3, frame: 99 },
  };
  const habitat = withHabitat(busy);
  assert.equal(habitat.view, "habitat");
  assert.equal(habitat.wakeRoute, "");
  assert.equal(habitat.pending, "");
  // Domain- and AWR-derived mirrors are untouched by an Experience reset.
  assert.equal(habitat.domainStatus, "READY");
  assert.equal(habitat.domainLastEvent, "SESSION_STARTED");
  assert.deepEqual({ ...habitat.world }, { ...busy.world });
});

test("S5. states and attribute maps are frozen; inputs are never mutated", () => {
  const before = initialShellState("READY");
  const after = withWake(before, { route: "DISCOVER_MENU", pending: "NONE" });
  assert.ok(Object.isFrozen(before));
  assert.ok(Object.isFrozen(after));
  assert.equal(before.view, "habitat");
  assert.ok(Object.isFrozen(shellAttributes(after)));
});

test("S6. the attribute map is exactly the documented data-* hooks, all strings, and carries no business data", () => {
  const attributes = shellAttributes(initialShellState("READY"));
  assert.deepEqual(Object.keys(attributes).sort(), [
    "data-aul-interactions",
    "data-aul-mood",
    "data-domain-last-event",
    "data-domain-status",
    "data-interaction-phase",
    "data-pending",
    "data-view",
    "data-wake-route",
    "data-world-camera",
    "data-world-frame",
    "data-world-presentation",
  ]);
  for (const value of Object.values(attributes)) assert.equal(typeof value, "string");
  // No product, price, cart, order, or identity field can appear as a hook.
  for (const name of Object.keys(attributes)) {
    assert.equal(/product|price|cart|order|total|uid|owner|customer|name|note/i.test(name), false, name);
  }
});

test("S7. numeric mirrors are stringified", () => {
  const state: ShellState = { ...initialShellState("READY"), world: { presentationMode: "WORLD", camera: "WORLD_VIEW", aulMood: "idle", aulInteractions: 7, frame: 1234 } };
  const attributes = shellAttributes(state);
  assert.equal(attributes["data-aul-interactions"], "7");
  assert.equal(attributes["data-world-frame"], "1234");
});
