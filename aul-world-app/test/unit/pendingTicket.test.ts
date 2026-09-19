// U1 targeted tests for src/experience/pendingTicket.ts (brief sections 10,
// 11 and 16-J). Snapshots come from the REAL Kiosk Host/Runtime/Experience
// projection, driven into each Domain state through its own public actions -
// so these tests also pin the contract between ExperienceSnapshotView and
// the real ExperienceSnapshot. Nothing in kiosk/ is modified.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { classifyPending, hasPendingTicket, routeCustomerReturn } from "../../src/experience/pendingTicket.ts";
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
  assert.equal(hasPendingTicket(classifyPending(snapshot)), true);
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
  assert.equal(hasPendingTicket(classifyPending(snapshot)), false);
});

test("J5. CONFIRMATION -> pending", async () => {
  const { orchestrator } = await readyFixture(succeedingCallable());
  orchestrator.addItem(ITEM);
  const outcome = await orchestrator.submit();
  assert.equal(outcome.outcome, "SUCCEEDED");
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.session, "confirmation");
  assert.equal(classifyPending(snapshot), "CONFIRMATION");
  assert.equal(hasPendingTicket(classifyPending(snapshot)), true);
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
  assert.equal(hasPendingTicket(classifyPending(snapshot)), true);
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

test("F1. routing maps each pending kind to exactly one destination", async () => {
  const idle = await readyFixture();
  assert.deepEqual({ ...routeCustomerReturn(idle.orchestrator.getSnapshot()) }, { route: "DISCOVER_MENU", pending: "NONE" });

  const emptyActive = await readyFixture();
  emptyActive.orchestrator.addItem(ITEM);
  emptyActive.orchestrator.clearCart();
  assert.deepEqual({ ...routeCustomerReturn(emptyActive.orchestrator.getSnapshot()) }, { route: "DISCOVER_MENU", pending: "NONE" });

  const withCart = await readyFixture();
  withCart.orchestrator.addItem(ITEM);
  assert.deepEqual({ ...routeCustomerReturn(withCart.orchestrator.getSnapshot()) }, { route: "OWNERSHIP_CONFIRMATION", pending: "ACTIVE_CART" });

  const confirmed = await readyFixture(succeedingCallable());
  confirmed.orchestrator.addItem(ITEM);
  await confirmed.orchestrator.submit();
  assert.deepEqual({ ...routeCustomerReturn(confirmed.orchestrator.getSnapshot()) }, { route: "OWNERSHIP_CONFIRMATION", pending: "CONFIRMATION" });

  const unknown = await readyFixture(unknownCallable());
  unknown.orchestrator.addItem(ITEM);
  await unknown.orchestrator.submit();
  assert.deepEqual({ ...routeCustomerReturn(unknown.orchestrator.getSnapshot()) }, { route: "OWNERSHIP_CONFIRMATION", pending: "UNRESOLVED" });
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
