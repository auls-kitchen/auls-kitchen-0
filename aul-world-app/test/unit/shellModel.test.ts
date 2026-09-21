// U3 tests for src/shell/shellModel.ts - the pure mapping behind the shell's
// data-* hooks. No DOM needed; the DOM writer itself is proven in the browser e2e.

import test from "node:test";
import assert from "node:assert/strict";

import { initialShellState, resolveHomeActivation, shellAttributes, viewForRoute, withHabitat, withWake } from "../../src/shell/shellModel.ts";
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

// ============================================================
// Home/X activation gate (U4 Slice 2A)
// ============================================================

function latch(phaseBefore: string | undefined) {
  const calls = { count: 0 };
  return {
    calls,
    consume: () => {
      calls.count += 1;
      return phaseBefore === undefined ? null : ({ phaseBefore } as { phaseBefore: never });
    },
  };
}

test("S8. a trusted click with a latched press yields exactly that phase, consuming the latch once", () => {
  for (const phase of ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "HABITAT_IDLE"]) {
    const { calls, consume } = latch(phase);
    assert.deepEqual(resolveHomeActivation({ isTrusted: true }, consume), { phaseBefore: phase });
    assert.equal(calls.count, 1);
  }
});

test("S9. an untrusted click does NOTHING and never even touches the latch (script .click(), dispatched clicks)", () => {
  for (const event of [{ isTrusted: false }, {}, { isTrusted: undefined }, { isTrusted: "true" as unknown as boolean }, { isTrusted: 1 as unknown as boolean }, null, undefined]) {
    const { calls, consume } = latch("RELEASED");
    assert.equal(resolveHomeActivation(event, consume), null, JSON.stringify(event));
    assert.equal(calls.count, 0, "the latch was not consumed by an untrusted click");
  }
});

test("S10. a trusted click with NO latched press does nothing", () => {
  const { calls, consume } = latch(undefined);
  assert.equal(resolveHomeActivation({ isTrusted: true }, consume), null);
  assert.equal(calls.count, 1);
  assert.equal(resolveHomeActivation({ isTrusted: true }, () => undefined), null);
});

test("S11. a malformed latch is no latch: missing or non-string phase", () => {
  for (const junk of [{}, { phaseBefore: 5 }, { phaseBefore: null }, { phaseBefore: undefined }, 7, "RELEASED", true]) {
    assert.equal(resolveHomeActivation({ isTrusted: true }, () => junk as never), null, JSON.stringify(junk));
  }
});

test("S12. a latch reader that throws is no latch: the click is dropped, the error does not escape into the DOM handler", () => {
  assert.equal(
    resolveHomeActivation({ isTrusted: true }, () => {
      throw new Error("latch unreadable");
    }),
    null,
  );
});

test("S13. the request is frozen and carries ONLY the phase - nothing else the latch held", () => {
  const request = resolveHomeActivation({ isTrusted: true }, () => ({ phaseBefore: "RELEASED", cart: ["x"], ownerUid: "u" }) as never);
  assert.ok(Object.isFrozen(request));
  assert.deepEqual(Object.keys(request!), ["phaseBefore"]);
});

test("S14. the latch is one-shot end to end: a second click with the same reader gets nothing once it is consumed", () => {
  let latched: { phaseBefore: "RELEASED" } | null = { phaseBefore: "RELEASED" };
  const consume = () => {
    const value = latched;
    latched = null;
    return value;
  };
  assert.deepEqual(resolveHomeActivation({ isTrusted: true }, consume), { phaseBefore: "RELEASED" });
  assert.equal(resolveHomeActivation({ isTrusted: true }, consume), null);
});

test("S15. entering Habitat / waking never fabricates a Home request: the shell state has no Home field at all", () => {
  const state = withWake(initialShellState("READY"), { route: "DISCOVER_MENU", pending: "NONE" });
  assert.equal(JSON.stringify(shellAttributes(state)).toLowerCase().includes("home"), false);
});
