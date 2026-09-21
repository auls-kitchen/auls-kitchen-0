// U1 targeted tests for src/experience/pendingTicket.ts (brief sections 10,
// 11 and 16-J). Snapshots come from the REAL Kiosk Host/Runtime/Experience
// projection, driven into each Domain state through its own public actions -
// so these tests also pin the contract between ExperienceSnapshotView and
// the real ExperienceSnapshot. Nothing in kiosk/ is modified.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyPending, releasePlanFor, routeCustomerReturn } from "../../src/experience/pendingTicket.ts";
import type { ExperienceSnapshotView } from "../../src/contracts.ts";
import {
  ITEM,
  createDeferredCallable,
  createKioskHostFixture,
  rejectingCallable,
  succeedingCallable,
  unknownCallable,
} from "./support/realKioskFixture.ts";

const require = createRequire(import.meta.url);
const { projectExperienceSnapshot } = require("../../../kiosk/experience/experienceProjection.js");

async function readyFixture(callable = succeedingCallable()) {
  const fixture = createKioskHostFixture(callable);
  await fixture.host.beginCustomerSession();
  return fixture;
}

// ============================================================
// J. Pending-ticket detection against real Domain states
// ============================================================

test("J1. before hydration the real snapshot is not ready -> NOT_READY", () => {
  const fixture = createKioskHostFixture(succeedingCallable());
  const snapshot = fixture.orchestrator.getSnapshot();
  assert.equal(snapshot.ready, false);
  assert.equal(classifyPending(snapshot), "NOT_READY");
});

test("J2. session IDLE (fresh customer) -> NONE", async () => {
  const { orchestrator } = await readyFixture();
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "idle");
  assert.equal(classifyPending(snapshot), "NONE");
});

test("J3. ACTIVE + cart lines -> ACTIVE_CART (pending)", async () => {
  const { orchestrator } = await readyFixture();
  orchestrator.addItem(ITEM);
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "active");
  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(classifyPending(snapshot), "ACTIVE_CART");
});

test("J4. ACTIVE + EMPTY cart is NOT a pending ticket (clearCart leaves session active)", async () => {
  const { orchestrator } = await readyFixture();
  orchestrator.addItem(ITEM);
  orchestrator.clearCart();
  const snapshot = orchestrator.getSnapshot();
  // The exact trap the brief warns about: session is still "active".
  assert.equal(snapshot.session, "active");
  assert.equal(snapshot.cart.lines.length, 0);
  assert.equal(classifyPending(snapshot), "NONE");
});

test("J5. CONFIRMATION -> pending", async () => {
  const { orchestrator } = await readyFixture(succeedingCallable());
  orchestrator.addItem(ITEM);
  const outcome = await orchestrator.submit();
  assert.equal(outcome.outcome, "SUCCEEDED");
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "confirmation");
  assert.equal(classifyPending(snapshot), "CONFIRMATION");
});

test("J6. AWAITING_OUTCOME / UNKNOWN -> UNRESOLVED (pending)", async () => {
  const { orchestrator } = await readyFixture(unknownCallable());
  orchestrator.addItem(ITEM);
  const outcome = await orchestrator.submit();
  assert.equal(outcome.outcome, "UNKNOWN");
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "awaiting_outcome");
  assert.equal(snapshot.order.status, "UNCERTAIN");
  assert.equal(classifyPending(snapshot), "UNRESOLVED");
});

test("J7. a submit() still IN FLIGHT is UNRESOLVED even though the order status still reads NONE", async () => {
  const deferred = createDeferredCallable();
  const { orchestrator } = await readyFixture(deferred.callable);
  orchestrator.addItem(ITEM);
  const pendingSubmit = orchestrator.submit();
  // Let the Runtime dispatch SUBMISSION_STARTED and reach the network call.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deferred.started(), true);

  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "awaiting_outcome");
  assert.equal(snapshot.order.status, "NONE", "the Runtime holds no submission object until the call settles");
  assert.equal(classifyPending(snapshot), "UNRESOLVED");

  deferred.release();
  await pendingSubmit;
});

test("J8. a REJECTED submission returns to ACTIVE with the cart kept -> ACTIVE_CART", async () => {
  const { orchestrator } = await readyFixture(rejectingCallable());
  orchestrator.addItem(ITEM);
  const outcome = await orchestrator.submit();
  assert.equal(outcome.outcome, "REJECTED");
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "active");
  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(classifyPending(snapshot), "ACTIVE_CART");
});

test("J9. the degraded hydration anomaly (submission and result coexist) is UNRESOLVED", () => {
  const snapshot = projectExperienceSnapshot({
    cart: { lines: [], customerName: null, notes: null },
    submission: { idempotencyKey: "key-00000001", status: "UNKNOWN", items: [], customerName: null, notes: null },
    session: "AWAITING_OUTCOME",
    authoritativeResult: { orderState: "VALIDATED", authoritativeTotal: 0, items: [], customerName: null, notes: null },
    hydrated: true,
  });
  assert.notEqual(snapshot.degraded, null);
  assert.equal(classifyPending(snapshot), "UNRESOLVED");
});

// ============================================================
// Fail-closed handling of unusable input
// ============================================================

test("J10. missing or malformed snapshots fail closed to NOT_READY, never NONE", () => {
  const cases: unknown[] = [
    null,
    undefined,
    {},
    "snapshot",
    [],
    { ready: true },
    { ready: true, session: "active" },
    { ready: true, session: "active", cart: {} , order: { status: "NONE" } },
    { ready: true, session: "active", cart: { lines: [] } },
    { ready: true, session: "not-a-session", cart: { lines: [] }, order: { status: "NONE" } },
    { ready: "yes", session: "idle", cart: { lines: [] }, order: { status: "NONE" } },
  ];
  for (const candidate of cases) {
    assert.equal(classifyPending(candidate as ExperienceSnapshotView), "NOT_READY", JSON.stringify(candidate));
  }
});

test("J11. an unhydrated snapshot is NOT_READY even if it carries a cart", async () => {
  const snapshot = projectExperienceSnapshot({
    cart: { lines: [{ localLineId: "l1", productId: "p1", quantity: 1, selectedModifiers: [], displaySnapshot: {} }], customerName: null, notes: null },
    submission: null,
    session: "ACTIVE",
    authoritativeResult: null,
    hydrated: false,
  });
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.cart.lines.length, 1);
  assert.equal(classifyPending(snapshot), "NOT_READY");
});

test("J12. classification is read-only: a deeply frozen real snapshot is never mutated", async () => {
  const { orchestrator } = await readyFixture();
  orchestrator.addItem(ITEM);
  const snapshot = orchestrator.getSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  const before = JSON.stringify(snapshot);
  classifyPending(snapshot);
  routeCustomerReturn(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
});

// ============================================================
// F (pure part). Return routing decision
// ============================================================

test("F1. routing maps each Domain state to exactly one destination; with no verdict a releasable context fails closed", async () => {
  const idle = await readyFixture();
  assert.deepEqual({ ...routeCustomerReturn(idle.orchestrator.getSnapshot()) }, { route: "DISCOVER_MENU", pending: "NONE" });

  // A releasable context (ACTIVE empty, ACTIVE + Cart, CONFIRMATION) is never shown as a
  // fresh kiosk without the caller's own FRESH verdict: it is neutral, never an ownership question.
  const emptyActive = await readyFixture();
  emptyActive.orchestrator.addItem(ITEM);
  emptyActive.orchestrator.clearCart();
  assert.deepEqual({ ...routeCustomerReturn(emptyActive.orchestrator.getSnapshot()) }, { route: "UNAVAILABLE_NEUTRAL", pending: "NONE" });

  const withCart = await readyFixture();
  withCart.orchestrator.addItem(ITEM);
  assert.deepEqual({ ...routeCustomerReturn(withCart.orchestrator.getSnapshot()) }, { route: "UNAVAILABLE_NEUTRAL", pending: "ACTIVE_CART" });

  const confirmed = await readyFixture(succeedingCallable());
  confirmed.orchestrator.addItem(ITEM);
  await confirmed.orchestrator.submit();
  assert.deepEqual({ ...routeCustomerReturn(confirmed.orchestrator.getSnapshot()) }, { route: "UNAVAILABLE_NEUTRAL", pending: "CONFIRMATION" });

  const unknown = await readyFixture(unknownCallable());
  unknown.orchestrator.addItem(ITEM);
  await unknown.orchestrator.submit();
  assert.deepEqual({ ...routeCustomerReturn(unknown.orchestrator.getSnapshot()) }, { route: "PROTECTED_NEUTRAL", pending: "UNRESOLVED" });
});

test("F2. a not-ready snapshot routes to WAIT_NOT_READY (never Discover)", () => {
  assert.deepEqual({ ...routeCustomerReturn(null) }, { route: "WAIT_NOT_READY", pending: "NOT_READY" });
  const fixture = createKioskHostFixture(succeedingCallable());
  assert.deepEqual(
    { ...routeCustomerReturn(fixture.orchestrator.getSnapshot()) },
    { route: "WAIT_NOT_READY", pending: "NOT_READY" },
  );
});

test("F3. routing only reads: the Domain state is identical before and after", async () => {
  const { orchestrator } = await readyFixture(unknownCallable());
  orchestrator.addItem(ITEM);
  await orchestrator.submit();
  const before = JSON.stringify(orchestrator.getSnapshot());
  for (let i = 0; i < 5; i++) routeCustomerReturn(orchestrator.getSnapshot());
  assert.equal(JSON.stringify(orchestrator.getSnapshot()), before);
  assert.equal(orchestrator.getSnapshot().session, "awaiting_outcome");
});

// ============================================================
// U4 Slice 2B, S4a: the ownership route is retired; routing is verdict-aware
// ============================================================
//
// routeCustomerReturn(snapshot, verdict?) is the one pure router. The verdict is the
// caller's OWN release outcome for the context in THAT snapshot; it can only ever matter
// when the snapshot holds a releasable context, and it can only ever be trusted when it is
// exactly "FRESH". No input can produce an ownership question.

const ROUTES = ["WAIT_NOT_READY", "DISCOVER_MENU", "PROTECTED_NEUTRAL", "UNAVAILABLE_NEUTRAL"];
const VERDICTS: unknown[] = [undefined, "FRESH", "UNAVAILABLE", "fresh", "RELEASED", "NOTHING_TO_RELEASE", "", null, 0, 1, true, {}, [], "OWNERSHIP_CONFIRMATION"];

const ALL_SESSIONS = ["idle", "active", "awaiting_outcome", "confirmation"];
const ALL_STATUSES = ["NONE", "PENDING", "UNCERTAIN", "CONFIRMED", "DECLINED"];

test("F4. OWNERSHIP_CONFIRMATION cannot be produced: every state x cart size x verdict lands on one of exactly four routes", () => {
  let checked = 0;
  for (const ready of [true, false]) {
    for (const session of ALL_SESSIONS) {
      for (const lines of [0, 1, 4]) {
        for (const status of ALL_STATUSES) {
          for (const verdict of VERDICTS) {
            const decision = routeCustomerReturn(snap(session, lines, status, ready), verdict as never);
            assert.ok(ROUTES.includes(decision.route), `${ready}/${session}/${lines}/${status}/${String(verdict)} -> ${decision.route}`);
            assert.notEqual(decision.route as string, "OWNERSHIP_CONFIRMATION");
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 2 * 4 * 3 * 5 * VERDICTS.length);
  for (const junk of [null, undefined, {}, "x", 7, []]) {
    assert.ok(ROUTES.includes(routeCustomerReturn(junk as never, "FRESH").route));
  }
});

test("F5. the route vocabulary is exactly four presentation routes, and the retired one exists nowhere in the code", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "experience", "pendingTicket.ts"), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  const union = code.match(/export type WakeRoute =([^;]+);/)![1]!;
  assert.deepEqual([...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  assert.equal(/OWNERSHIP_CONFIRMATION/.test(code), false, "the retired route is gone from the code");
  assert.equal(/hasPendingTicket/.test(code), false, "the ownership route's helper is gone with it");
});

test("F6. a releasable context is DISCOVER_MENU only for the exact verdict FRESH; every other value fails closed", () => {
  const releasable = [snap("active", 0, "NONE"), snap("active", 2, "NONE"), snap("active", 1, "DECLINED"), snap("confirmation", 1, "CONFIRMED")];
  for (const snapshot of releasable) {
    assert.equal(releasePlanFor(snapshot), "RELEASE");
    assert.deepEqual({ ...routeCustomerReturn(snapshot, "FRESH") }, { route: "DISCOVER_MENU", pending: "NONE" }, "the context is gone, so nothing pends");
    for (const verdict of VERDICTS.filter((v) => v !== "FRESH")) {
      assert.equal(routeCustomerReturn(snapshot, verdict as never).route, "UNAVAILABLE_NEUTRAL", String(verdict));
    }
    assert.equal(routeCustomerReturn(snapshot, "UNAVAILABLE").route, "UNAVAILABLE_NEUTRAL");
  }
});

test("F7. a verdict can never launder a protected or unreadable Domain: PROTECTED stays neutral, NOT_READY stays waiting, under every verdict", () => {
  const protectedStates = [snap("awaiting_outcome", 1, "UNCERTAIN"), snap("awaiting_outcome", 1, "NONE"), snap("active", 1, "PENDING"), snap("idle", 0, "UNCERTAIN")];
  for (const snapshot of protectedStates) {
    assert.equal(releasePlanFor(snapshot), "PROTECTED");
    for (const verdict of VERDICTS) {
      assert.equal(routeCustomerReturn(snapshot, verdict as never).route, "PROTECTED_NEUTRAL", `${snapshot.session}/${String(verdict)}`);
    }
  }
  for (const verdict of VERDICTS) {
    assert.equal(routeCustomerReturn(snap("active", 1, "NONE", false), verdict as never).route, "WAIT_NOT_READY");
    assert.equal(routeCustomerReturn(null, verdict as never).route, "WAIT_NOT_READY");
  }
});

test("F8. an idle Domain has nothing to release, so its route ignores the verdict (even UNAVAILABLE)", () => {
  for (const verdict of VERDICTS) {
    assert.deepEqual({ ...routeCustomerReturn(snap("idle", 0, "NONE"), verdict as never) }, { route: "DISCOVER_MENU", pending: "NONE" }, String(verdict));
  }
});

test("F9. the decision is a frozen, plain pair; routing with a verdict only reads (the real Domain is untouched)", async () => {
  const { orchestrator } = await readyFixture(succeedingCallable());
  orchestrator.addItem(ITEM);
  await orchestrator.submit();
  const before = JSON.stringify(orchestrator.getSnapshot());
  const decision = routeCustomerReturn(orchestrator.getSnapshot(), "FRESH");
  assert.ok(Object.isFrozen(decision));
  assert.deepEqual(Object.keys(decision).sort(), ["pending", "route"]);
  for (const verdict of VERDICTS) routeCustomerReturn(orchestrator.getSnapshot(), verdict as never);
  assert.equal(JSON.stringify(orchestrator.getSnapshot()), before);
  assert.equal(orchestrator.getSnapshot().session, "confirmation", "routing never released anything");
});

// ============================================================
// U4 Slice 2B, S3: releasePlanFor - what an expiry may ask the Domain to do
// ============================================================
//
// RELEASE / NONE_TO_RELEASE / PROTECTED / NOT_READY. Pure and read-only. Checked twice:
// against hand-built snapshots (the whole table, including malformed ones) and against
// the REAL Kiosk Domain driven into each state - so it also pins the contract with the
// real ExperienceSnapshot shape (`session`, `cart.lines`, `order.status`).

function snap(session: string, lines: number, status: string, ready = true): ExperienceSnapshotView {
  return {
    ready,
    session,
    cart: { lines: Array.from({ length: lines }, () => ({})) },
    order: { status },
    degraded: null,
  } as unknown as ExperienceSnapshotView;
}

test("RP1. ACTIVE with an empty Cart, ACTIVE with Cart lines, and CONFIRMATION are RELEASE", () => {
  assert.equal(releasePlanFor(snap("active", 0, "NONE")), "RELEASE", "ACTIVE + empty Cart (name/notes/session are still customer context)");
  assert.equal(releasePlanFor(snap("active", 1, "NONE")), "RELEASE");
  assert.equal(releasePlanFor(snap("active", 5, "DECLINED")), "RELEASE", "a rejection leaves ACTIVE with the Cart kept");
  assert.equal(releasePlanFor(snap("confirmation", 1, "CONFIRMED")), "RELEASE");
  assert.equal(releasePlanFor(snap("confirmation", 0, "CONFIRMED")), "RELEASE");
});

test("RP2. UNKNOWN, AWAITING_OUTCOME and any pending/uncertain order are PROTECTED", () => {
  assert.equal(releasePlanFor(snap("awaiting_outcome", 1, "UNCERTAIN")), "PROTECTED", "UNKNOWN");
  assert.equal(releasePlanFor(snap("awaiting_outcome", 1, "NONE")), "PROTECTED", "a submit still in flight (order still NONE)");
  assert.equal(releasePlanFor(snap("awaiting_outcome", 0, "PENDING")), "PROTECTED");
  assert.equal(releasePlanFor(snap("active", 1, "UNCERTAIN")), "PROTECTED", "an uncertain order on an otherwise active session");
  assert.equal(releasePlanFor(snap("active", 0, "PENDING")), "PROTECTED");
  assert.equal(releasePlanFor(snap("confirmation", 1, "UNCERTAIN")), "PROTECTED", "a confirmation-looking session whose order is unresolved");
  assert.equal(releasePlanFor(snap("idle", 0, "UNCERTAIN")), "PROTECTED");
});

test("RP3. an idle session is NONE_TO_RELEASE", () => {
  assert.equal(releasePlanFor(snap("idle", 0, "NONE")), "NONE_TO_RELEASE");
  assert.equal(releasePlanFor(snap("idle", 0, "CONFIRMED")), "NONE_TO_RELEASE");
});

test("RP4. anything malformed or unreadable is NOT_READY - never RELEASE, never NONE_TO_RELEASE", () => {
  const hostile = {
    get ready(): boolean {
      throw new Error("hostile getter");
    },
  };
  const hostileSession = { ready: true, cart: { lines: [] }, order: { status: "NONE" }, get session(): string { throw new Error("hostile session"); } };
  const bad: unknown[] = [
    null,
    undefined,
    "active",
    42,
    [],
    {},
    snap("active", 1, "NONE", false), // not ready
    snap("weird", 1, "NONE"),
    snap("", 1, "NONE"),
    { ready: true, session: "active", cart: { lines: "x" }, order: { status: "NONE" } },
    { ready: true, session: "active", cart: { lines: [] } },
    { ready: true, session: "active", order: { status: "NONE" } },
    { ready: "true", session: "active", cart: { lines: [] }, order: { status: "NONE" } },
    { ready: true, session: undefined, cart: { lines: [] }, order: { status: "NONE" } },
    hostile,
    hostileSession,
    new Proxy({}, { get() { throw new Error("hostile proxy"); } }),
  ];
  bad.forEach((value, index) => {
    assert.doesNotThrow(() => releasePlanFor(value as ExperienceSnapshotView), `bad[${index}] must not throw`);
    assert.equal(releasePlanFor(value as ExperienceSnapshotView), "NOT_READY", `bad[${index}]`);
  });
});

test("RP5. the plan agrees with classifyPending: it never RELEASES what classifyPending calls UNRESOLVED, and only releases ACTIVE / CONFIRMATION sessions", () => {
  for (const session of ["idle", "active", "awaiting_outcome", "confirmation"]) {
    for (const lines of [0, 1, 3]) {
      for (const status of ["NONE", "PENDING", "UNCERTAIN", "CONFIRMED", "DECLINED"]) {
        const snapshot = snap(session, lines, status);
        const plan = releasePlanFor(snapshot);
        if (classifyPending(snapshot) === "UNRESOLVED") assert.equal(plan, "PROTECTED", `${session}/${lines}/${status}`);
        if (plan === "RELEASE") assert.ok(session === "active" || session === "confirmation", `${session}/${lines}/${status}`);
        if (session === "idle" && plan !== "PROTECTED") assert.equal(plan, "NONE_TO_RELEASE", `${session}/${lines}/${status}`);
      }
    }
  }
});

test("RP6. pure: frozen input accepted and never mutated, a constant returned, the same answer every time", () => {
  const frozen = Object.freeze({ ready: true, session: "active", cart: Object.freeze({ lines: Object.freeze([{}]) }), order: Object.freeze({ status: "NONE" }), degraded: null });
  for (let i = 0; i < 3; i++) assert.equal(releasePlanFor(frozen as unknown as ExperienceSnapshotView), "RELEASE");
  const written: string[] = [];
  const watched = new Proxy(structuredClone(frozen), {
    set: (_t, p) => { written.push(String(p)); return false; },
    defineProperty: (_t, p) => { written.push(String(p)); return false; },
    deleteProperty: (_t, p) => { written.push(String(p)); return false; },
  });
  releasePlanFor(watched as unknown as ExperienceSnapshotView);
  assert.deepEqual(written, []);
  assert.equal(typeof releasePlanFor(frozen as unknown as ExperienceSnapshotView), "string");
});

test("RP7. against the REAL Kiosk Domain: fresh -> NONE_TO_RELEASE, ACTIVE Cart -> RELEASE, ACTIVE empty -> RELEASE, CONFIRMATION -> RELEASE", async () => {
  const notHydrated = createKioskHostFixture(succeedingCallable());
  assert.equal(releasePlanFor(notHydrated.orchestrator.getSnapshot()), "NOT_READY", "before hydration");

  const fresh = await readyFixture();
  assert.equal(releasePlanFor(fresh.orchestrator.getSnapshot()), "NONE_TO_RELEASE");

  const withCart = await readyFixture();
  withCart.orchestrator.addItem(ITEM);
  assert.equal(releasePlanFor(withCart.orchestrator.getSnapshot()), "RELEASE");

  const emptyActive = await readyFixture();
  emptyActive.orchestrator.addItem(ITEM);
  emptyActive.orchestrator.clearCart();
  assert.equal(emptyActive.orchestrator.getSnapshot().session, "active");
  assert.equal(releasePlanFor(emptyActive.orchestrator.getSnapshot()), "RELEASE", "the trap: classifyPending calls this NONE, but it IS customer context");

  const confirmed = await readyFixture(succeedingCallable());
  confirmed.orchestrator.addItem(ITEM);
  await confirmed.orchestrator.submit();
  assert.equal(releasePlanFor(confirmed.orchestrator.getSnapshot()), "RELEASE");
});

test("RP8. against the REAL Kiosk Domain: UNKNOWN and a submit still in flight are PROTECTED, and a rejected submit is RELEASE", async () => {
  const unknown = await readyFixture(unknownCallable());
  unknown.orchestrator.addItem(ITEM);
  await unknown.orchestrator.submit();
  assert.equal(releasePlanFor(unknown.orchestrator.getSnapshot()), "PROTECTED");

  const deferred = createDeferredCallable();
  const inFlight = await readyFixture(deferred.callable);
  inFlight.orchestrator.addItem(ITEM);
  const pendingSubmit = inFlight.orchestrator.submit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releasePlanFor(inFlight.orchestrator.getSnapshot()), "PROTECTED", "AWAITING_OUTCOME with the order still reading NONE");
  deferred.release();
  await pendingSubmit;

  const rejected = await readyFixture(rejectingCallable());
  rejected.orchestrator.addItem(ITEM);
  await rejected.orchestrator.submit();
  assert.equal(rejected.orchestrator.getSnapshot().session, "active");
  assert.equal(releasePlanFor(rejected.orchestrator.getSnapshot()), "RELEASE");
});

test("RP9. the plan only reads: the real Domain is identical before and after any number of calls", async () => {
  const { orchestrator } = await readyFixture(unknownCallable());
  orchestrator.addItem(ITEM);
  await orchestrator.submit();
  const before = JSON.stringify(orchestrator.getSnapshot());
  for (let i = 0; i < 5; i++) releasePlanFor(orchestrator.getSnapshot());
  assert.equal(JSON.stringify(orchestrator.getSnapshot()), before);
});

test("RP10. classifyPending is untouched (S3 and S4a): the same answers as before for every state; only routing changed", () => {
  assert.equal(classifyPending(snap("active", 0, "NONE")), "NONE");
  assert.equal(classifyPending(snap("active", 1, "NONE")), "ACTIVE_CART");
  assert.equal(classifyPending(snap("confirmation", 1, "CONFIRMED")), "CONFIRMATION");
  assert.equal(classifyPending(snap("awaiting_outcome", 1, "UNCERTAIN")), "UNRESOLVED");
  assert.deepEqual({ ...routeCustomerReturn(snap("confirmation", 1, "CONFIRMED")) }, { route: "UNAVAILABLE_NEUTRAL", pending: "CONFIRMATION" });
  assert.deepEqual({ ...routeCustomerReturn(snap("idle", 0, "NONE")) }, { route: "DISCOVER_MENU", pending: "NONE" });
});
