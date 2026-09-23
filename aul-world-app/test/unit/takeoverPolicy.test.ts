// U4 Slice 2A tests for src/experience/takeoverPolicy.ts.
//
// The policy is a pure decision: (phaseBefore, Domain snapshot) -> one of five
// constant names. These tests pin the whole decision table, prove that only
// RELEASED plus a releasable snapshot can ever become a takeover, prove that an
// unresolved (UNKNOWN / AWAITING_OUTCOME) submission is BLOCKED in every phase,
// and prove the policy has no capability to call, mutate, or emit anything.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as policyModule from "../../src/experience/takeoverPolicy.ts";
import { decideTakeover } from "../../src/experience/takeoverPolicy.ts";
import type { TakeoverDecision } from "../../src/experience/takeoverPolicy.ts";
import type { RestingPhase } from "../../src/experience/interactionContext.ts";
import type { ExperienceSnapshotView } from "../../src/contracts.ts";
import { importSpecifiers, scanSource, stripComments } from "./support/sourceScan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "src");
const POLICY_PATH = path.join(SRC_ROOT, "experience", "takeoverPolicy.ts");

const PHASES: readonly RestingPhase[] = ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "HABITAT_IDLE"];

type Order = ExperienceSnapshotView["order"]["status"];

function snapshot(session: ExperienceSnapshotView["session"], lines: number, order: Order = "NONE", ready = true): ExperienceSnapshotView {
  return Object.freeze({
    ready,
    session,
    cart: Object.freeze({ lines: Object.freeze(Array.from({ length: lines }, (_, i) => Object.freeze({ lineRef: `line-${i}` }))) }),
    order: Object.freeze({ status: order }),
    degraded: null,
  });
}

// The Domain states the policy can be handed.
const IDLE = snapshot("idle", 0);
const ACTIVE_EMPTY = snapshot("active", 0);
const ACTIVE_CART = snapshot("active", 1);
const ACTIVE_CART_MANY = snapshot("active", 3);
const CONFIRMATION = snapshot("confirmation", 1, "CONFIRMED");
const CONFIRMATION_NO_LINES = snapshot("confirmation", 0, "CONFIRMED");
const AWAITING_IN_FLIGHT = snapshot("awaiting_outcome", 1, "NONE"); // submit() in flight: the order is still NONE
const UNKNOWN = snapshot("awaiting_outcome", 1, "UNCERTAIN");
const PENDING_ORDER = snapshot("active", 1, "PENDING");
const UNCERTAIN_ON_ACTIVE = snapshot("active", 1, "UNCERTAIN");
const CONFIRMATION_BUT_UNRESOLVED = snapshot("confirmation", 1, "UNCERTAIN");

const UNREADABLE: ReadonlyArray<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["not ready", snapshot("active", 1, "NONE", false)],
  ["empty object", {}],
  ["a string", "active"],
  ["unknown session", { ready: true, session: "weird", cart: { lines: [] }, order: { status: "NONE" }, degraded: null }],
  ["missing cart", { ready: true, session: "active", order: { status: "NONE" }, degraded: null }],
  ["cart.lines not an array", { ready: true, session: "active", cart: { lines: "x" }, order: { status: "NONE" }, degraded: null }],
  ["missing order", { ready: true, session: "active", cart: { lines: [] }, degraded: null }],
];

// ============================================================
// The decision table (phase x Domain state)
// ============================================================

const RELEASABLE_TABLE: ReadonlyArray<[string, ExperienceSnapshotView, Record<RestingPhase, TakeoverDecision>]> = [
  [
    "ACTIVE + Cart >= 1",
    ACTIVE_CART,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "TAKEOVER_ACTIVE_CART", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
  [
    "ACTIVE + many Cart lines",
    ACTIVE_CART_MANY,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "TAKEOVER_ACTIVE_CART", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
  [
    "CONFIRMATION",
    CONFIRMATION,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "TAKEOVER_CONFIRMATION", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
  [
    "CONFIRMATION (no Cart lines: a confirmation is itself a ticket context)",
    CONFIRMATION_NO_LINES,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "TAKEOVER_CONFIRMATION", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
  [
    "ACTIVE + EMPTY Cart (no ticket-based ownership boundary)",
    ACTIVE_EMPTY,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "NO_TAKEOVER", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
  [
    "IDLE",
    IDLE,
    { ACTIVE_STANDBY: "NO_TAKEOVER", SPACE_GIVEN: "NO_TAKEOVER", RELEASED: "NO_TAKEOVER", HABITAT_IDLE: "NO_TAKEOVER" },
  ],
];

test("TP1. the full phase x releasable-state table (ACTIVE + Cart, CONFIRMATION, ACTIVE empty, IDLE)", () => {
  for (const [label, state, expectations] of RELEASABLE_TABLE) {
    for (const phaseBefore of PHASES) {
      assert.equal(decideTakeover({ phaseBefore, snapshot: state }), expectations[phaseBefore], `${label} @ ${phaseBefore}`);
    }
  }
});

test("TP2. ACTIVE + Cart before 25s is NO_TAKEOVER; at RELEASED it is TAKEOVER_ACTIVE_CART", () => {
  assert.equal(decideTakeover({ phaseBefore: "ACTIVE_STANDBY", snapshot: ACTIVE_CART }), "NO_TAKEOVER");
  assert.equal(decideTakeover({ phaseBefore: "SPACE_GIVEN", snapshot: ACTIVE_CART }), "NO_TAKEOVER");
  assert.equal(decideTakeover({ phaseBefore: "RELEASED", snapshot: ACTIVE_CART }), "TAKEOVER_ACTIVE_CART");
});

test("TP3. CONFIRMATION after 25s is TAKEOVER_CONFIRMATION, and before 25s it is not", () => {
  assert.equal(decideTakeover({ phaseBefore: "RELEASED", snapshot: CONFIRMATION }), "TAKEOVER_CONFIRMATION");
  assert.equal(decideTakeover({ phaseBefore: "SPACE_GIVEN", snapshot: CONFIRMATION }), "NO_TAKEOVER");
  assert.equal(decideTakeover({ phaseBefore: "ACTIVE_STANDBY", snapshot: CONFIRMATION }), "NO_TAKEOVER");
});

test("TP4. ACTIVE + empty Cart is NO_TAKEOVER in every phase, including RELEASED", () => {
  for (const phaseBefore of PHASES) {
    assert.equal(decideTakeover({ phaseBefore, snapshot: ACTIVE_EMPTY }), "NO_TAKEOVER", phaseBefore);
  }
});

test("TP5. an unreadable Domain is NOT_READY in every phase (never guessed as 'no ticket', never a takeover)", () => {
  for (const [label, unreadable] of UNREADABLE) {
    for (const phaseBefore of PHASES) {
      assert.equal(decideTakeover({ phaseBefore, snapshot: unreadable as ExperienceSnapshotView }), "NOT_READY", `${label} @ ${phaseBefore}`);
    }
  }
});

// ============================================================
// UNKNOWN / AWAITING_OUTCOME is protected in every phase
// ============================================================

const UNRESOLVED: ReadonlyArray<[string, ExperienceSnapshotView]> = [
  ["AWAITING_OUTCOME, submit in flight (order still NONE)", AWAITING_IN_FLIGHT],
  ["UNKNOWN (AWAITING_OUTCOME + UNCERTAIN order)", UNKNOWN],
  ["a PENDING order", PENDING_ORDER],
  ["an UNCERTAIN order on an otherwise active session", UNCERTAIN_ON_ACTIVE],
  ["a confirmation-looking session whose order is UNCERTAIN", CONFIRMATION_BUT_UNRESOLVED],
];

test("TP6. UNKNOWN / AWAITING_OUTCOME is BLOCKED_UNKNOWN in EVERY phase, including RELEASED", () => {
  for (const [label, state] of UNRESOLVED) {
    for (const phaseBefore of PHASES) {
      assert.equal(decideTakeover({ phaseBefore, snapshot: state }), "BLOCKED_UNKNOWN", `${label} @ ${phaseBefore}`);
    }
  }
});

test("TP7. an unresolved submission can NEVER produce a takeover, whatever the phase - even an unexpected one", () => {
  const phases = [...PHASES, "CONTEXT_EXPIRED", "released", "", undefined, null, 5] as unknown[];
  for (const [label, state] of UNRESOLVED) {
    for (const phaseBefore of phases) {
      const decision = decideTakeover({ phaseBefore: phaseBefore as RestingPhase, snapshot: state });
      assert.equal(decision, "BLOCKED_UNKNOWN", `${label} @ ${String(phaseBefore)}`);
      assert.equal(decision.startsWith("TAKEOVER"), false);
    }
  }
});

test("TP8. UNKNOWN involves no capability at all: a snapshot carrying Domain-style methods never has one called, read, or replaced", () => {
  const calls: string[] = [];
  const trap = (name: string) => () => void calls.push(name);
  const poisoned = {
    ...UNKNOWN,
    clearCart: trap("clearCart"),
    endSession: trap("endSession"),
    retryUnknown: trap("retryUnknown"),
    releaseCustomerContext: trap("releaseCustomerContext"),
    hydrate: trap("hydrate"),
    requestAuthReset: trap("requestAuthReset"),
  };
  const touched: Array<string | symbol> = [];
  const observed = new Proxy(poisoned, {
    get(target, property, receiver) {
      touched.push(property);
      return Reflect.get(target, property, receiver);
    },
    set() {
      throw new Error("the policy must not write to the snapshot");
    },
    deleteProperty() {
      throw new Error("the policy must not delete from the snapshot");
    },
    defineProperty() {
      throw new Error("the policy must not define on the snapshot");
    },
  }) as unknown as ExperienceSnapshotView;

  for (const phaseBefore of PHASES) {
    assert.equal(decideTakeover({ phaseBefore, snapshot: observed }), "BLOCKED_UNKNOWN");
  }
  assert.deepEqual(calls, [], "no Domain-style method was ever invoked");
  for (const name of ["clearCart", "endSession", "retryUnknown", "releaseCustomerContext", "hydrate", "requestAuthReset"]) {
    assert.equal(touched.includes(name), false, `${name} was not even read`);
  }
});

// ============================================================
// Only RELEASED + a releasable snapshot can take over
// ============================================================

test("TP9. exhaustive: TAKEOVER_* appears exactly for RELEASED x {ACTIVE + Cart, CONFIRMATION}, and nowhere else", () => {
  const states: ReadonlyArray<[string, unknown]> = [
    ["idle", IDLE],
    ["active empty", ACTIVE_EMPTY],
    ["active cart", ACTIVE_CART],
    ["confirmation", CONFIRMATION],
    ...UNRESOLVED,
    ...UNREADABLE,
  ];
  const phases = [...PHASES, "CONTEXT_EXPIRED", "released", "", undefined, null] as unknown[];
  const allowed = new Set<string>(["NO_TAKEOVER", "TAKEOVER_ACTIVE_CART", "TAKEOVER_CONFIRMATION", "BLOCKED_UNKNOWN", "NOT_READY"]);
  const takeovers: string[] = [];
  for (const [label, state] of states) {
    for (const phaseBefore of phases) {
      const decision = decideTakeover({ phaseBefore: phaseBefore as RestingPhase, snapshot: state as ExperienceSnapshotView });
      assert.ok(allowed.has(decision), `unexpected result ${decision}`);
      if (decision.startsWith("TAKEOVER")) takeovers.push(`${label} @ ${String(phaseBefore)} -> ${decision}`);
    }
  }
  assert.deepEqual(takeovers.sort(), ["active cart @ RELEASED -> TAKEOVER_ACTIVE_CART", "confirmation @ RELEASED -> TAKEOVER_CONFIRMATION"]);
});

test("TP10. fail closed on an unexpected phase: anything that is not exactly RELEASED is NO_TAKEOVER", () => {
  for (const phaseBefore of ["CONTEXT_EXPIRED", "released", "RELEASED ", "", undefined, null, 0, {}] as unknown[]) {
    assert.equal(decideTakeover({ phaseBefore: phaseBefore as RestingPhase, snapshot: ACTIVE_CART }), "NO_TAKEOVER", String(phaseBefore));
    assert.equal(decideTakeover({ phaseBefore: phaseBefore as RestingPhase, snapshot: CONFIRMATION }), "NO_TAKEOVER", String(phaseBefore));
  }
});

test("TP11. HABITAT_IDLE never takes over: a press that woke the kiosk is the wake path, not Home", () => {
  for (const state of [ACTIVE_CART, CONFIRMATION, ACTIVE_EMPTY, IDLE]) {
    assert.equal(decideTakeover({ phaseBefore: "HABITAT_IDLE", snapshot: state }), "NO_TAKEOVER");
  }
});

// ============================================================
// Purity
// ============================================================

test("TP12. pure: same input, same decision; frozen inputs are accepted and never mutated", () => {
  const input = Object.freeze({ phaseBefore: "RELEASED" as const, snapshot: ACTIVE_CART });
  const first = decideTakeover(input);
  for (let i = 0; i < 5; i++) assert.equal(decideTakeover(input), first);
  assert.equal(first, "TAKEOVER_ACTIVE_CART");
  assert.deepEqual(input.snapshot, snapshot("active", 1));
});

test("TP13. the decision is a plain string: no object, no callback, no handle", () => {
  for (const [, state] of RELEASABLE_TABLE) {
    for (const phaseBefore of PHASES) {
      assert.equal(typeof decideTakeover({ phaseBefore, snapshot: state }), "string");
    }
  }
});

test("TP14. total: a snapshot that cannot even be inspected is NOT_READY - it never throws, and never becomes a takeover", () => {
  const hostile = {
    get ready(): boolean {
      throw new Error("boom");
    },
  };
  for (const phaseBefore of PHASES) {
    assert.equal(decideTakeover({ phaseBefore, snapshot: hostile as unknown as ExperienceSnapshotView }), "NOT_READY");
  }
});

// ============================================================
// Structure: the module has no capability
// ============================================================

test("TP15. the module exports exactly one function, decideTakeover", () => {
  assert.deepEqual(Object.keys(policyModule).sort(), ["decideTakeover"]);
});

test("TP16. its only imports are the contracts type, the phase type, and the pure pending-ticket classifier", () => {
  const code = stripComments(fs.readFileSync(POLICY_PATH, "utf8"));
  assert.deepEqual([...new Set(importSpecifiers(code))].sort(), ["../contracts.ts", "./interactionContext.ts", "./pendingTicket.ts"]);
});

test("TP17. it names no Domain capability, no clock, no outside import (the Experience authority scan)", () => {
  assert.deepEqual(scanSource(POLICY_PATH, fs.readFileSync(POLICY_PATH, "utf8"), SRC_ROOT), []);
});

test("TP18. it touches no DOM, timer, network, storage, event bus, or shell/composition", () => {
  const code = stripComments(fs.readFileSync(POLICY_PATH, "utf8"));
  for (const token of [
    "document",
    "window",
    "addEventListener",
    "dispatchEvent",
    "emit",
    "setTimeout",
    "setInterval",
    "fetch",
    "localStorage",
    "indexedDB",
    "shell",
    "composition",
    "host",
    "orchestrator",
    "releaseCustomer",
    "console",
  ]) {
    assert.equal(new RegExp(`\\b${token}\\w*\\b`, "i").test(code), false, `the policy must not mention ${token}`);
  }
});

test("TP19. negative control: the scan would catch a policy that tried to release or clear", () => {
  const tainted = `export const x = (d) => { d.clearCart(); d.releaseCustomerContext(); d.retryUnknown(); };`;
  const violations = scanSource(POLICY_PATH, tainted, SRC_ROOT);
  assert.ok(violations.some((v) => v.detail === "clearCart"));
  assert.ok(violations.some((v) => v.detail === "releaseCustomerContext"));
  assert.ok(violations.some((v) => v.detail === "retryUnknown"));
});
