// U2 targeted tests for src/experience/createExperienceLifecycle.ts.
// Brief section 16: A (timing), B (input reset), C (timer safety), D (cart
// preserved), E (UNKNOWN preserved), F (habitat return), G (no fake input),
// H (lifecycle), plus section 14 (Domain events during Habitat).
//
// The Domain tests drive the REAL, unmodified Kiosk Host/Runtime/Experience
// (kiosk/host/kioskHost.js) with in-memory fakes. The lifecycle is given ONLY
// a read-only getSnapshot port over it - the same narrow port production will
// use - and every Domain-side effect a timer could have (cart, session,
// submission, persistence, auth, callable) is measured before and after.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_GESTURE_MAX_AGE_MS, createExperienceLifecycle } from "../../src/experience/createExperienceLifecycle.ts";
import type { ExperienceLifecycleOptions } from "../../src/experience/createExperienceLifecycle.ts";
import { CUSTOMER_INPUT_EVENT_TYPES } from "../../src/experience/customerInput.ts";
import { resolveHomeActivation } from "../../src/shell/shellModel.ts";
import type { InteractionPhase } from "../../src/experience/interactionContext.ts";
import type { WakeDecision } from "../../src/experience/pendingTicket.ts";
import { createMonotonicClock, createTimeoutScheduler } from "../../src/experience/silenceTimer.ts";
import type { ExperienceSnapshotView, SnapshotReadPort } from "../../src/contracts.ts";
import { createFakeInputTarget, makeEvent, synthetic, trusted } from "./support/fakeInputTarget.ts";
import { createFakeTime } from "./support/fakeTime.ts";
import {
  ITEM,
  createDeferredCallable,
  createKioskHostFixture,
  succeedingCallable,
  unknownCallable,
} from "./support/realKioskFixture.ts";

const IDLE_READY: ExperienceSnapshotView = Object.freeze({
  ready: true,
  session: "idle",
  cart: Object.freeze({ lines: Object.freeze([]) }),
  order: Object.freeze({ status: "NONE" }),
  degraded: null,
});

interface HarnessOptions {
  readonly snapshots?: SnapshotReadPort;
  readonly ordering?: boolean;
  readonly thresholds?: ExperienceLifecycleOptions["thresholds"];
  readonly gestureMaxAgeMs?: number;
  readonly onContextExpired?: ExperienceLifecycleOptions["onContextExpired"];
}

function harness(options: HarnessOptions = {}) {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const phases: InteractionPhase[] = [];
  const wakes: WakeDecision[] = [];
  const errors: unknown[] = [];
  const calls = { getSnapshot: 0, returnToWorld: 0 };
  const world = { ordering: options.ordering ?? false };

  const source: SnapshotReadPort = options.snapshots ?? { getSnapshot: () => IDLE_READY };
  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: {
      getSnapshot: () => {
        calls.getSnapshot += 1;
        return source.getSnapshot();
      },
    },
    presentation: {
      returnToWorld: () => {
        calls.returnToWorld += 1;
      },
    },
    world: { isOrdering: () => world.ordering },
    thresholds: options.thresholds,
    gestureMaxAgeMs: options.gestureMaxAgeMs,
    onContextExpired: options.onContextExpired,
    onPhase: (phase) => phases.push(phase),
    onWake: (decision) => wakes.push(decision),
    onError: (error) => errors.push(error),
  });
  lifecycle.start();
  return { time, input, lifecycle, phases, wakes, errors, calls, world };
}

// ============================================================
// A. Experience timing (through the whole lifecycle)
// ============================================================

test("L1. boot HABITAT_IDLE; input -> ACTIVE_STANDBY; 15s SPACE_GIVEN; 25s RELEASED; 5min HABITAT_IDLE", () => {
  const { time, input, lifecycle, phases } = harness();
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  assert.deepEqual(phases, [], "boot is a resting state, not a transition");

  input.dispatch(trusted.tap());
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");

  time.advanceBy(15_000);
  assert.equal(lifecycle.getPhase(), "SPACE_GIVEN");
  time.advanceBy(10_000);
  assert.equal(lifecycle.getPhase(), "RELEASED");
  time.advanceBy(275_000);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");

  assert.deepEqual(phases, ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

// ============================================================
// B. Input reset
// ============================================================

test("L2. each kind of trusted customer input restarts the silence window", () => {
  const inputs = [trusted.tap, trusted.drag, trusted.touchSwipe, trusted.wheel, trusted.enterOnButton];
  for (const makeInput of inputs) {
    const { time, input, lifecycle } = harness();
    input.dispatch(trusted.tap());
    time.advanceBy(20_000);
    assert.equal(lifecycle.getPhase(), "SPACE_GIVEN");

    input.dispatch(makeInput());
    assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");
    time.advanceBy(14_999);
    assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");
    time.advanceBy(1);
    assert.equal(lifecycle.getPhase(), "SPACE_GIVEN");
  }
});

test("L3. input during RELEASED, and just before 5min, prevents Habitat", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(299_999);
  assert.equal(lifecycle.getPhase(), "RELEASED");
  input.dispatch(trusted.tap());
  time.advanceBy(1);
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");
});

// ============================================================
// G. No fake input / timer never wakes
// ============================================================

test("L4. the timer never wakes HABITAT_IDLE: an hour of silence and every possible callback changes nothing", () => {
  const { time, input, lifecycle, phases, calls } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  const phaseCount = phases.length;
  const snapshotReads = calls.getSnapshot;

  time.advanceBy(3_600_000);
  time.fireDue();
  time.fireStale();

  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  assert.equal(phases.length, phaseCount);
  assert.equal(calls.getSnapshot, snapshotReads, "no snapshot is read without customer input");
  assert.equal(time.pendingCount(), 0);
  assert.equal(phases.filter((p) => p === "ACTIVE_STANDBY").length, 1, "only the one real customer wake");
});

test("L5. synthetic events, hover, scroll and non-interaction events never wake Habitat or read the Domain", () => {
  const { input, lifecycle, phases, calls, wakes } = harness();
  input.dispatch(synthetic.tap());
  input.dispatch(synthetic.wheel());
  input.dispatch(synthetic.enterOnButton());
  input.dispatch(trusted.hover());
  input.dispatch(makeEvent("scroll"));
  input.dispatch(makeEvent("pointerup"));
  input.dispatch(makeEvent("TICK"));
  input.dispatch(makeEvent("resize"));

  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  assert.deepEqual(phases, []);
  assert.deepEqual(wakes, []);
  assert.equal(calls.getSnapshot, 0);
});

test("L6. synthetic events never reset an active silence window", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(14_000);
  input.dispatch(synthetic.tap());
  input.dispatch(synthetic.wheel());
  input.dispatch(trusted.hover());
  time.advanceBy(1_000);
  assert.equal(lifecycle.getPhase(), "SPACE_GIVEN", "the window was NOT restarted by non-customer activity");
});

// ============================================================
// F. Habitat return
// ============================================================

test("L7. waking from Habitat reads exactly ONE snapshot; resets while active read none", () => {
  const { time, input, calls, wakes } = harness();
  input.dispatch(trusted.tap());
  assert.equal(calls.getSnapshot, 1);
  assert.equal(wakes.length, 1);

  input.dispatch(trusted.tap());
  input.dispatch(trusted.drag());
  time.advanceBy(20_000);
  input.dispatch(trusted.tap());
  assert.equal(calls.getSnapshot, 1, "input while already awake never re-reads the Domain");
  assert.equal(wakes.length, 1);

  time.advanceBy(300_000); // Habitat again
  input.dispatch(trusted.tap());
  assert.equal(calls.getSnapshot, 2);
  assert.equal(wakes.length, 2);
});

test("L8. the wake decision follows the snapshot read at that moment (not a cached one)", () => {
  let current: ExperienceSnapshotView = IDLE_READY;
  const { time, input, wakes } = harness({ snapshots: { getSnapshot: () => current } });

  input.dispatch(trusted.tap());
  assert.deepEqual({ ...wakes[0]! }, { route: "DISCOVER_MENU", pending: "NONE" });

  time.advanceBy(300_000);
  current = { ready: true, session: "confirmation", cart: { lines: [{}] }, order: { status: "CONFIRMED" }, degraded: null };
  input.dispatch(trusted.tap());
  assert.deepEqual({ ...wakes[1]! }, { route: "OWNERSHIP_CONFIRMATION", pending: "CONFIRMATION" });

  time.advanceBy(300_000);
  current = { ready: false, session: "idle", cart: { lines: [] }, order: { status: "NONE" }, degraded: null };
  input.dispatch(trusted.tap());
  assert.deepEqual({ ...wakes[2]! }, { route: "WAIT_NOT_READY", pending: "NOT_READY" });
});

test("L9. a snapshot read that throws fails closed to WAIT_NOT_READY and never throws into the DOM event", () => {
  const { input, wakes, errors, lifecycle } = harness({
    snapshots: {
      getSnapshot: () => {
        throw new Error("domain unreadable");
      },
    },
  });
  assert.doesNotThrow(() => input.dispatch(trusted.tap()));
  assert.deepEqual({ ...wakes[0]! }, { route: "WAIT_NOT_READY", pending: "NOT_READY" });
  assert.equal(errors.length, 1);
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");
});

// ============================================================
// Habitat entry (approved decision: returnToWorld only when ORDERING)
// ============================================================

test("L10. entering Habitat calls returnToWorld exactly once when AWR is in ORDERING", () => {
  const { time, input, calls } = harness({ ordering: true });
  input.dispatch(trusted.tap());
  time.advanceBy(15_000);
  time.advanceBy(10_000);
  assert.equal(calls.returnToWorld, 0, "15s and 25s are Experience-only: no AWR effect");
  time.advanceBy(275_000);
  assert.equal(calls.returnToWorld, 1);
  time.advanceBy(3_600_000);
  assert.equal(calls.returnToWorld, 1, "and never again while idle");
});

test("L11. entering Habitat does NOT call returnToWorld when AWR is not in ORDERING", () => {
  const { time, input, calls } = harness({ ordering: false });
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  assert.equal(calls.returnToWorld, 0);
});

test("L12. returnToWorld is not called by a wake, and the ORDERING probe is read at Habitat entry", () => {
  const { time, input, calls, world } = harness({ ordering: false });
  input.dispatch(trusted.tap());
  world.ordering = true; // the customer entered ordering while active
  time.advanceBy(300_000);
  assert.equal(calls.returnToWorld, 1);

  input.dispatch(trusted.tap()); // wake
  assert.equal(calls.returnToWorld, 1, "waking never emits a world transition");
});

test("L13. failures in presentation, the ORDERING probe, or callbacks are isolated and reported", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const errors: unknown[] = [];
  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: {
      returnToWorld: () => {
        throw new Error("presentation failed");
      },
    },
    world: { isOrdering: () => true },
    onPhase: () => {
      throw new Error("phase callback failed");
    },
    onWake: () => {
      throw new Error("wake callback failed");
    },
    onError: (e) => errors.push(e),
  });
  lifecycle.start();

  assert.doesNotThrow(() => input.dispatch(trusted.tap()));
  // First wake: onPhase(ACTIVE_STANDBY) throws + onWake throws.
  assert.equal(errors.length, 2);
  time.advanceBy(300_000);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE", "the lifecycle still completed the timeline");
  // Then onPhase throws for SPACE_GIVEN, RELEASED, CONTEXT_EXPIRED, HABITAT_IDLE
  // (4) and returnToWorld throws once at Habitat entry (1): 2 + 4 + 1.
  assert.equal(errors.length, 7);
  input.dispatch(trusted.tap());
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY", "and it still wakes afterwards");
});

// ============================================================
// C. Timer safety - structural surface
// ============================================================

test("L14. the lifecycle's whole reach is its three narrow ports: nothing else is ever touched", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const guard = <T extends object>(name: string, allowed: string[], target: T): T =>
    new Proxy(target, {
      get(t, property, receiver) {
        if (typeof property === "string" && !allowed.includes(property)) {
          throw new Error(`${name}.${property} was accessed; only ${allowed.join(", ")} is allowed`);
        }
        return Reflect.get(t, property, receiver);
      },
    });

  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: guard("snapshots", ["getSnapshot"], { getSnapshot: () => IDLE_READY }),
    presentation: guard("presentation", ["returnToWorld"], { returnToWorld: () => {} }),
    world: guard("world", ["isOrdering"], { isOrdering: () => true }),
  });
  lifecycle.start();

  // A full customer cycle: wake, silence to Habitat, wake again, dispose.
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  lifecycle.dispose();
});

test("L15. the returned object exposes only start / dispose / getPhase / consumeGesture (no input sink, no timer)", () => {
  const { lifecycle } = harness();
  assert.deepEqual(Object.keys(lifecycle).sort(), ["consumeGesture", "dispose", "getPhase", "start"]);
  assert.ok(Object.isFrozen(lifecycle));
  assert.equal("noteCustomerInput" in lifecycle, false);
});

test("L16. methods work when detached from the object (no reliance on `this`)", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const { start, dispose, getPhase } = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
  });
  start();
  input.dispatch(trusted.tap());
  assert.equal(getPhase(), "ACTIVE_STANDBY");
  dispose();
  assert.equal(input.activeListenerCount(), 0);
});

// ============================================================
// D / E. The Domain is untouched by 15s, 25s, 5min, Habitat and wake
// ============================================================

type DomainKind = "active_cart" | "confirmation" | "unknown";

async function buildDomain(kind: DomainKind) {
  const fixture = createKioskHostFixture(kind === "confirmation" ? succeedingCallable() : unknownCallable());
  await fixture.host.beginCustomerSession();
  fixture.orchestrator.addItem(ITEM);
  if (kind !== "active_cart") await fixture.orchestrator.submit();
  return fixture;
}

function measureDomain(fixture: Awaited<ReturnType<typeof buildDomain>>) {
  return {
    snapshot: fixture.orchestrator.getSnapshot(),
    store: JSON.stringify([...fixture.store.entries()]),
    orderIntentCalls: fixture.calls.orderIntent(),
    resolveOwnerUidCalls: fixture.calls.resolveOwnerUid(),
    requestAuthResetCalls: fixture.calls.requestAuthReset(),
  };
}

const EXPECTED_PENDING: Record<DomainKind, { session: string; pending: string; order: string }> = {
  active_cart: { session: "active", pending: "ACTIVE_CART", order: "NONE" },
  confirmation: { session: "confirmation", pending: "CONFIRMATION", order: "CONFIRMED" },
  unknown: { session: "awaiting_outcome", pending: "UNRESOLVED", order: "UNCERTAIN" },
};

for (const kind of ["active_cart", "confirmation", "unknown"] as const) {
  test(`D/E. ${kind}: 15s, 25s, 5min, Habitat and wake leave the real Domain completely untouched`, async () => {
    const fixture = await buildDomain(kind);
    const domainEvents: unknown[] = [];
    fixture.orchestrator.subscribe((event) => domainEvents.push(event));

    const expected = EXPECTED_PENDING[kind];
    const before = measureDomain(fixture);
    assert.equal(before.snapshot.session, expected.session);
    assert.equal(before.snapshot.order.status, expected.order);
    assert.equal(before.snapshot.cart.lines.length, 1);

    const { time, input, lifecycle, wakes, calls } = harness({
      snapshots: { getSnapshot: () => fixture.orchestrator.getSnapshot() },
      ordering: true,
    });

    // The customer interacts, then goes silent through every threshold.
    input.dispatch(trusted.tap());
    assert.deepEqual({ ...wakes[0]! }, { route: "OWNERSHIP_CONFIRMATION", pending: expected.pending });
    time.advanceBy(15_000);
    assert.equal(lifecycle.getPhase(), "SPACE_GIVEN");
    assert.deepEqual(measureDomain(fixture), before, "Domain changed at 15s");
    time.advanceBy(10_000);
    assert.equal(lifecycle.getPhase(), "RELEASED");
    assert.deepEqual(measureDomain(fixture), before, "Domain changed at 25s");
    time.advanceBy(275_000);
    assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
    assert.equal(calls.returnToWorld, 1);

    // 5min expiry: nothing cleared, ended, retried, hydrated, rotated or purged.
    const after = measureDomain(fixture);
    assert.deepEqual(after.snapshot, before.snapshot, "snapshot changed at 5min");
    assert.equal(after.store, before.store, "persistence changed at 5min");
    assert.equal(after.orderIntentCalls, before.orderIntentCalls, "OrderIntent was called (retry)");
    assert.equal(after.resolveOwnerUidCalls, before.resolveOwnerUidCalls, "identity was re-resolved (hydrate)");
    assert.equal(after.requestAuthResetCalls, 0, "auth was reset / UID rotated");
    assert.equal(domainEvents.length, 0, "the Domain emitted an event (session end, outcome change, ...)");
    assert.equal(after.snapshot.session, expected.session);
    assert.equal(after.snapshot.cart.lines.length, 1);

    // Habitat return: a customer comes back; only the snapshot is read.
    input.dispatch(trusted.tap());
    assert.deepEqual({ ...wakes[1]! }, { route: "OWNERSHIP_CONFIRMATION", pending: expected.pending });
    assert.deepEqual(measureDomain(fixture), before, "Domain changed on wake");
    assert.equal(domainEvents.length, 0);

    if (kind === "unknown") {
      assert.equal(after.snapshot.capabilities.canRetryUnknown, true, "UNKNOWN is still recoverable by the Domain, not by us");
      assert.equal(fixture.calls.orderIntent(), 1, "exactly the original submit; no retry");
    }
    lifecycle.dispose();
  });
}

test("Domain events during Habitat: an in-flight order settles while the kiosk is in Habitat and the lifecycle neither reacts nor fabricates", async () => {
  const deferred = createDeferredCallable();
  const fixture = createKioskHostFixture(deferred.callable);
  await fixture.host.beginCustomerSession();
  fixture.orchestrator.addItem(ITEM);
  const domainEvents: Array<{ type: string }> = [];
  fixture.orchestrator.subscribe((event) => domainEvents.push(event as { type: string }));

  const pendingSubmit = fixture.orchestrator.submit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deferred.started(), true);
  assert.equal(fixture.orchestrator.getSnapshot().session, "awaiting_outcome");

  const { time, input, lifecycle, phases, wakes, calls } = harness({
    snapshots: { getSnapshot: () => fixture.orchestrator.getSnapshot() },
    ordering: true,
  });
  input.dispatch(trusted.tap());
  assert.deepEqual({ ...wakes[0]! }, { route: "OWNERSHIP_CONFIRMATION", pending: "UNRESOLVED" });

  time.advanceBy(300_000);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  assert.equal(fixture.orchestrator.getSnapshot().session, "awaiting_outcome", "elapsed time does not resolve ambiguity");
  assert.equal(fixture.calls.requestAuthReset(), 0);

  // The backend answers while nobody is at the kiosk.
  const phasesBefore = phases.length;
  const readsBefore = calls.getSnapshot;
  deferred.release();
  await pendingSubmit;

  const settled = fixture.orchestrator.getSnapshot();
  assert.equal(settled.session, "confirmation");
  assert.equal(settled.order.status, "CONFIRMED");
  assert.ok(domainEvents.some((e) => e.type === "ORDER_OUTCOME_CHANGED"));

  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE", "a Domain event is not customer input and does not wake Habitat");
  assert.equal(phases.length, phasesBefore);
  assert.equal(calls.getSnapshot, readsBefore, "the lifecycle does not read the Domain on Domain events");

  // The customer returns and sees the real, settled state.
  input.dispatch(trusted.tap());
  assert.deepEqual({ ...wakes[1]! }, { route: "OWNERSHIP_CONFIRMATION", pending: "CONFIRMATION" });
  lifecycle.dispose();
});

// ============================================================
// H. Lifecycle / disposal / re-initialization
// ============================================================

test("H1. repeated mount -> run -> dispose -> mount leaves no duplicate or leaked listener, timer, or callback", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const perInstance: InteractionPhase[][] = [];

  for (let cycle = 0; cycle < 4; cycle++) {
    const phases: InteractionPhase[] = [];
    perInstance.push(phases);
    const lifecycle = createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => {} },
      world: { isOrdering: () => false },
      onPhase: (p) => phases.push(p),
    });

    lifecycle.start();
    assert.equal(input.activeListenerCount(), 5, `cycle ${cycle}: exactly one listener per type`);
    assert.equal(time.pendingCount(), 0);

    input.dispatch(trusted.tap());
    assert.deepEqual(phases, ["ACTIVE_STANDBY"], `cycle ${cycle}: this instance saw the tap exactly once`);
    assert.equal(time.pendingCount(), 1, `cycle ${cycle}: exactly one timer`);

    lifecycle.dispose();
    assert.equal(input.activeListenerCount(), 0, `cycle ${cycle}: every listener removed`);
    assert.equal(time.pendingCount(), 0, `cycle ${cycle}: timer cleared`);

    // A disposed instance is inert: input, time, and even a stale timeout do nothing.
    const seen = phases.length;
    assert.equal(input.dispatch(trusted.tap()), 0, "no listener remains to receive input");
    time.advanceBy(600_000);
    time.fireStale();
    assert.equal(phases.length, seen, `cycle ${cycle}: stale callback fired into a disposed instance`);
  }

  assert.equal(input.totalRegistrations(), 20, "5 listeners per mount, never more");
  assert.equal(time.maxPendingSeen(), 1, "never more than one timer at once, across all cycles");
  // Earlier instances never heard about later ones.
  for (const phases of perInstance) assert.deepEqual(phases, ["ACTIVE_STANDBY"]);
});

test("H2. start() twice does not duplicate listeners; dispose() twice is safe; start() after dispose throws", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
  });

  lifecycle.start();
  lifecycle.start();
  assert.equal(input.totalRegistrations(), 5);
  assert.equal(input.activeListenerCount(), 5);

  lifecycle.dispose();
  assert.doesNotThrow(() => lifecycle.dispose());
  assert.equal(input.activeListenerCount(), 0);
  assert.throws(() => lifecycle.start(), /disposed/);
  assert.equal(input.totalRegistrations(), 5, "a rejected restart registered nothing");
});

test("H3. two lifecycles mounted at once are independent", () => {
  const timeA = createFakeTime();
  const timeB = createFakeTime();
  const inputA = createFakeInputTarget();
  const inputB = createFakeInputTarget();
  const make = (time: ReturnType<typeof createFakeTime>, input: ReturnType<typeof createFakeInputTarget>) =>
    createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => {} },
      world: { isOrdering: () => false },
    });
  const a = make(timeA, inputA);
  const b = make(timeB, inputB);
  a.start();
  b.start();

  inputA.dispatch(trusted.tap());
  assert.equal(a.getPhase(), "ACTIVE_STANDBY");
  assert.equal(b.getPhase(), "HABITAT_IDLE");

  a.dispose();
  inputB.dispatch(trusted.tap());
  assert.equal(b.getPhase(), "ACTIVE_STANDBY");
  b.dispose();
});

test("H4. a target that fails to bind leaves nothing running and the error surfaces", () => {
  const time = createFakeTime();
  const brittle = {
    addEventListener: () => {
      throw new Error("cannot bind");
    },
  } as unknown as EventTarget;
  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: brittle,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
  });
  assert.throws(() => lifecycle.start(), /cannot bind/);
  assert.equal(time.pendingCount(), 0);
  assert.throws(() => lifecycle.start(), /disposed/, "a failed start disposes the instance");
});

test("H5. end to end with the REAL monotonic clock, REAL timeouts and a REAL EventTarget (scaled thresholds)", async () => {
  const target = new EventTarget();
  const phases: InteractionPhase[] = [];
  const lifecycle = createExperienceLifecycle({
    clock: createMonotonicClock(),
    scheduler: createTimeoutScheduler(),
    inputTarget: target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
    thresholds: { spaceGivenMs: 30, releasedMs: 60, contextExpiredMs: 150 },
    onPhase: (p) => phases.push(p),
  });
  lifecycle.start();

  // A script-dispatched event (isTrusted === false) is not customer input.
  target.dispatchEvent(new Event("pointerdown"));
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");

  // A trusted event is. (Node lets a test mark an instance trusted; browsers do not.)
  const tap = new Event("pointerdown");
  Object.defineProperty(tap, "isTrusted", { value: true });
  target.dispatchEvent(tap);
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");

  const deadline = performance.now() + 3_000;
  while (lifecycle.getPhase() !== "HABITAT_IDLE" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  lifecycle.dispose();

  assert.deepEqual(phases, ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

// ============================================================
// Phase-before-input (U4 Slice 2A): a PRESS latches the phase it found, once
// ============================================================

test("LG1. before any press there is nothing to consume", () => {
  const { lifecycle } = harness();
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LG2. a press at 10s / 20s / 26s latches ACTIVE_STANDBY / SPACE_GIVEN / RELEASED (the phase BEFORE the press reset the window)", () => {
  for (const [elapsed, expected] of [
    [10_000, "ACTIVE_STANDBY"],
    [20_000, "SPACE_GIVEN"],
    [26_000, "RELEASED"],
  ] as const) {
    const { time, input, lifecycle } = harness();
    input.dispatch(trusted.tap()); // customer A
    time.advanceBy(elapsed);
    input.dispatch(trusted.tap()); // the press under test
    assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY", "the press has already reset the window");
    assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: expected }, `${elapsed}ms`);
  }
});

test("LG3. DELAYED TIMER + 30s: the 25s callback has not fired, yet the press latches RELEASED", () => {
  const { time, input, lifecycle, phases } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000); // nothing fires
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");

  input.dispatch(trusted.tap());

  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
  assert.deepEqual(phases, ["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "ACTIVE_STANDBY"], "the missed phases are still reported, in order");
});

test("LG4. the latch is one-shot: consume once, then null", () => {
  const { input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" });
  assert.equal(lifecycle.consumeGesture(), null);
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LG5. a DRAG never overwrites the latch (pointer drag and touch swipe), and never creates one", () => {
  for (const makeDrag of [trusted.drag, trusted.touchSwipe]) {
    const { time, input, lifecycle } = harness();
    input.dispatch(trusted.tap());
    time.jumpBy(30_000);
    input.dispatch(trusted.tap()); // latches RELEASED
    input.dispatch(makeDrag()); // the window is ACTIVE_STANDBY now: a drag must not replace RELEASED
    input.dispatch(makeDrag());
    assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });

    const fresh = harness();
    fresh.input.dispatch(makeDrag());
    assert.equal(fresh.lifecycle.consumeGesture(), null, "a drag alone is not a gesture start");
  }
});

test("LG6. a WHEEL never overwrites the latch, and never creates one", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000);
  input.dispatch(trusted.tap());
  input.dispatch(trusted.wheel());
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });

  const fresh = harness();
  fresh.input.dispatch(trusted.wheel());
  assert.equal(fresh.lifecycle.consumeGesture(), null);
});

test("LG7. every NEW press overwrites the previous latch - and that fails safe: a later press at ACTIVE_STANDBY cannot inherit an older RELEASED", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000);
  input.dispatch(trusted.tap()); // latches RELEASED
  input.dispatch(trusted.tap()); // a second press, now at ACTIVE_STANDBY
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "ACTIVE_STANDBY" });

  // ...and the reverse: the LATEST press wins, whatever it found.
  const other = harness();
  other.input.dispatch(trusted.tap());
  other.time.advanceBy(5_000);
  other.input.dispatch(trusted.tap()); // ACTIVE_STANDBY
  other.time.jumpBy(30_000);
  other.input.dispatch(trusted.tap()); // RELEASED
  assert.deepEqual(other.lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
});

test("LG8. an Enter/Space press on an interactive element latches like a tap", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000);
  input.dispatch(trusted.enterOnButton());
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
});

test("LG9. anything that is not a trusted press never latches: synthetic press, hover, scroll, a non-interactive key, an auto-repeat", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  lifecycle.consumeGesture(); // discard the first press, so only what follows can latch
  time.jumpBy(30_000);
  for (const event of [
    synthetic.tap(),
    synthetic.enterOnButton(),
    trusted.hover(),
    makeEvent("scroll"),
    makeEvent("keydown", { key: "Enter", repeat: false, target: { tagName: "DIV" } }),
    makeEvent("keydown", { key: "Enter", repeat: true, target: { tagName: "BUTTON" } }),
  ]) {
    input.dispatch(event);
  }
  assert.equal(lifecycle.consumeGesture(), null);
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY", "and none of them reset or advanced the window");
});

test("LG10. a synthetic press does not disturb an earlier real latch", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000);
  input.dispatch(trusted.tap()); // real: latches RELEASED
  input.dispatch(synthetic.tap());
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
});

test("LG11. the latch is the phase before THAT press - a later phase change (inside the freshness window) does not rewrite it", () => {
  // Scaled thresholds, so the window really moves on while the latch is still fresh.
  const { time, input, lifecycle } = harness({ thresholds: { spaceGivenMs: 500, releasedMs: 1_000, contextExpiredMs: 50_000 } });
  input.dispatch(trusted.tap()); // from Habitat
  time.advanceBy(1_200);
  assert.equal(lifecycle.getPhase(), "RELEASED");
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" });
});

test("LG12. a late timer past 5 minutes: the press reports the expiry FIRST, latches HABITAT_IDLE, and wakes once", () => {
  const { time, input, lifecycle, phases, wakes, calls } = harness({ ordering: true });
  input.dispatch(trusted.tap());
  time.jumpBy(360_000);
  phases.length = 0;
  const readsBefore = calls.getSnapshot;
  const wakesBefore = wakes.length;

  input.dispatch(trusted.tap());

  assert.deepEqual(phases, ["SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE", "ACTIVE_STANDBY"]);
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" });
  assert.equal(wakes.length - wakesBefore, 1, "exactly one wake, after the expiry");
  assert.equal(calls.getSnapshot - readsBefore, 1, "exactly one snapshot read for this wake");
  assert.equal(calls.returnToWorld, 1, "Habitat entry still returns the World once");
});

test("LG13. a callback fired by the press itself never sees the PREVIOUS press latch", () => {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  let seenDuringDelivery: unknown = "unset";
  const lifecycle: ReturnType<typeof createExperienceLifecycle> = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
    onPhase: (phase) => {
      if (phase === "ACTIVE_STANDBY") seenDuringDelivery = lifecycle.consumeGesture();
    },
  });
  lifecycle.start();

  input.dispatch(trusted.tap()); // latches HABITAT_IDLE and is deliberately NOT consumed
  time.jumpBy(30_000);
  input.dispatch(trusted.tap()); // latches RELEASED, but only AFTER its own callbacks have run
  assert.equal(seenDuringDelivery, null, "the first press's phase was not visible while this press was being delivered");
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
});

test("LG14. dispose clears the latch, and nothing latches afterwards", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.jumpBy(30_000);
  input.dispatch(trusted.tap());
  lifecycle.dispose();
  assert.equal(lifecycle.consumeGesture(), null);
  input.dispatch(trusted.tap());
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LG15. consuming reads no Domain snapshot, and the latch is frozen data with only a phase", () => {
  const { input, lifecycle, calls } = harness();
  input.dispatch(trusted.tap());
  const readsBefore = calls.getSnapshot;
  const gesture = lifecycle.consumeGesture();
  assert.equal(calls.getSnapshot, readsBefore);
  assert.ok(Object.isFrozen(gesture));
  assert.deepEqual(Object.keys(gesture!), ["phaseBefore"]);
});

test("LG16. consumeGesture works detached from the object (no reliance on `this`)", () => {
  const { input, lifecycle } = harness();
  const { consumeGesture } = lifecycle;
  input.dispatch(trusted.tap());
  assert.deepEqual(consumeGesture(), { phaseBefore: "HABITAT_IDLE" });
});

// ============================================================
// Stale-latch freshness (U4 Slice 2B, S1 / O1): fail closed
// ============================================================
//
// A press latches {phaseBefore, at}; consumeGesture() honours it only while
// 0 <= age <= gestureMaxAgeMs, clears it whatever the outcome, and reads `at`
// from the injected monotonic clock BEFORE the timer processes the press.

// A lifecycle whose clock can be overridden (NaN, backwards) on top of the fake time.
function clockControlledLifecycle(extra: Partial<ExperienceLifecycleOptions> = {}) {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  let override: number | null = null;
  const clock = { now: (): number => (override === null ? time.clock.now() : override) };
  const lifecycle = createExperienceLifecycle({
    clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
    ...extra,
  });
  lifecycle.start();
  return { time, input, lifecycle, setClock: (value: number | null) => void (override = value) };
}

test("LF1. a fresh latch is accepted (age 0 and age 500 ms)", () => {
  for (const wait of [0, 500]) {
    const { time, input, lifecycle } = harness();
    input.dispatch(trusted.tap());
    time.advanceBy(wait);
    assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" }, `${wait}ms`);
  }
});

test("LF2. a stale latch is rejected (2001 ms with the default), consuming has no side effect on the window, and the latch is gone", () => {
  const { time, input, lifecycle, phases } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(DEFAULT_GESTURE_MAX_AGE_MS + 1);
  const pendingBefore = time.pendingCount();
  const phasesBefore = [...phases];

  assert.equal(lifecycle.consumeGesture(), null);

  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY", "refusing a stale latch changes nothing about the silence window");
  assert.equal(time.pendingCount(), pendingBefore);
  assert.deepEqual(phases, phasesBefore);
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LF3. the freshness boundary is inclusive: exactly the maximum is accepted, one millisecond more is not (default and custom)", () => {
  for (const [max, options] of [
    [DEFAULT_GESTURE_MAX_AGE_MS, {}],
    [750, { gestureMaxAgeMs: 750 }],
    [60_000, { gestureMaxAgeMs: 60_000 }],
  ] as const) {
    const exact = harness(options);
    exact.input.dispatch(trusted.tap());
    exact.time.advanceBy(max);
    assert.deepEqual(exact.lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" }, `exactly ${max}ms`);

    const over = harness(options);
    over.input.dispatch(trusted.tap());
    over.time.advanceBy(max + 1);
    assert.equal(over.lifecycle.consumeGesture(), null, `${max + 1}ms`);
  }
});

test("LF4. a NaN age is rejected", () => {
  const { input, lifecycle, setClock } = clockControlledLifecycle();
  input.dispatch(trusted.tap());
  setClock(Number.NaN);
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LF5. a negative age (a clock that went backwards) is rejected; age exactly 0 is accepted", () => {
  const zero = clockControlledLifecycle();
  zero.input.dispatch(trusted.tap());
  assert.deepEqual(zero.lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" }, "age 0");

  const backwards = clockControlledLifecycle();
  backwards.input.dispatch(trusted.tap());
  backwards.setClock(backwards.time.now() - 1);
  assert.equal(backwards.lifecycle.consumeGesture(), null, "age -1");

  const wayBack = clockControlledLifecycle();
  wayBack.input.dispatch(trusted.tap());
  wayBack.setClock(-Infinity);
  assert.equal(wayBack.lifecycle.consumeGesture(), null, "-Infinity");
  const wayForward = clockControlledLifecycle();
  wayForward.input.dispatch(trusted.tap());
  wayForward.setClock(Infinity);
  assert.equal(wayForward.lifecycle.consumeGesture(), null, "+Infinity");
});

test("LF6. the latch is one-shot: a consume clears it, and so does a REFUSED consume (a refusal is final)", () => {
  const fresh = harness();
  fresh.input.dispatch(trusted.tap());
  assert.deepEqual(fresh.lifecycle.consumeGesture(), { phaseBefore: "HABITAT_IDLE" });
  assert.equal(fresh.lifecycle.consumeGesture(), null);

  const { time, input, lifecycle, setClock } = clockControlledLifecycle();
  input.dispatch(trusted.tap());
  setClock(time.now() + 5_000); // stale
  assert.equal(lifecycle.consumeGesture(), null);
  setClock(null); // the clock is fresh again - the latch must still be gone
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LF7. a newer press overwrites the previous latch and restarts the age from the NEW press", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap()); // press 1: from Habitat
  time.advanceBy(1_500);
  input.dispatch(trusted.tap()); // press 2: at ACTIVE_STANDBY
  time.advanceBy(1_900); // 3.4s since press 1 (stale for it), 1.9s since press 2 (fresh)
  assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "ACTIVE_STANDBY" });
});

test("LF8. a script click or a trusted click carrying an OLD latch is rejected; a fresh trusted click is not", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(5_000);

  const consume = () => lifecycle.consumeGesture();
  assert.equal(resolveHomeActivation({ isTrusted: false }, consume), null, "an untrusted click never even reads the latch");
  assert.equal(resolveHomeActivation({ isTrusted: true }, consume), null, "a trusted click with a stale latch finds nothing");
  assert.equal(resolveHomeActivation({ isTrusted: true }, consume), null, "and the refusal was final");

  input.dispatch(trusted.tap()); // a new, fresh press
  time.advanceBy(300);
  assert.deepEqual({ ...resolveHomeActivation({ isTrusted: true }, consume)! }, { phaseBefore: "ACTIVE_STANDBY" });
});

test("LF9. no listener is added: still exactly the five capture listeners, however many presses and consumes happen", () => {
  const { time, input, lifecycle } = harness();
  const before = input.registrations();
  assert.equal(before.length, 5);
  for (let i = 0; i < 5; i++) {
    input.dispatch(trusted.tap());
    time.advanceBy(3_000);
    lifecycle.consumeGesture();
  }
  const after = input.registrations();
  assert.equal(input.totalRegistrations(), 5);
  assert.equal(input.activeListenerCount(), 5);
  assert.deepEqual(after.map((r) => r.type).sort(), [...CUSTOMER_INPUT_EVENT_TYPES].sort());
  assert.ok(after.every((r) => r.capture && r.passive && r.hasSignal && r.active));
});

test("LF10. the press time is read BEFORE the timer runs: slow downstream work makes the latch older, never younger", () => {
  for (const [downstreamMs, accepted] of [
    [1_500, true],
    [2_500, false],
  ] as const) {
    const time = createFakeTime();
    const input = createFakeInputTarget();
    const lifecycle = createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => {} },
      world: { isOrdering: () => false },
      // A phase callback runs inside timer.noteCustomerInput(): the press "takes a while".
      onPhase: (phase) => {
        if (phase === "ACTIVE_STANDBY") time.jumpBy(downstreamMs);
      },
    });
    lifecycle.start();

    input.dispatch(trusted.tap());

    const gesture = lifecycle.consumeGesture();
    if (accepted) assert.deepEqual(gesture, { phaseBefore: "HABITAT_IDLE" }, `${downstreamMs}ms of downstream work`);
    else assert.equal(gesture, null, `${downstreamMs}ms of downstream work must count against the latch`);
  }
});

test("LF11. the default maximum is exactly 2000 ms, and it is the one applied when none is configured", () => {
  assert.equal(DEFAULT_GESTURE_MAX_AGE_MS, 2000);
  const accepted = harness();
  accepted.input.dispatch(trusted.tap());
  accepted.time.advanceBy(2000);
  assert.notEqual(accepted.lifecycle.consumeGesture(), null);
  const rejected = harness();
  rejected.input.dispatch(trusted.tap());
  rejected.time.advanceBy(2001);
  assert.equal(rejected.lifecycle.consumeGesture(), null);
});

test("LF12. an injected maximum is honoured (tight and loose), and an invalid one is rejected at construction", () => {
  const tight = harness({ gestureMaxAgeMs: 100 });
  tight.input.dispatch(trusted.tap());
  tight.time.advanceBy(101);
  assert.equal(tight.lifecycle.consumeGesture(), null);

  const loose = harness({ gestureMaxAgeMs: 10_000 });
  loose.input.dispatch(trusted.tap());
  loose.time.advanceBy(9_000);
  assert.notEqual(loose.lifecycle.consumeGesture(), null);

  const build = (gestureMaxAgeMs: unknown) => {
    const time = createFakeTime();
    const input = createFakeInputTarget();
    const lifecycle = createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => {} },
      world: { isOrdering: () => false },
      gestureMaxAgeMs: gestureMaxAgeMs as number,
    });
    return { lifecycle, input, time };
  };
  for (const invalid of [0, -1, -0.001, Number.NaN, Infinity, -Infinity, null, "2000", true, {}, []]) {
    assert.throws(() => build(invalid), RangeError, `must reject ${String(invalid)}`);
  }
  for (const valid of [undefined, 0.5, 1, 2000, 60_000]) {
    assert.doesNotThrow(() => build(valid), `must accept ${String(valid)}`);
  }
  // Rejection happens before anything is bound.
  const probe = (() => {
    const time = createFakeTime();
    const input = createFakeInputTarget();
    try {
      createExperienceLifecycle({
        clock: time.clock,
        scheduler: time.scheduler,
        inputTarget: input.target,
        snapshots: { getSnapshot: () => IDLE_READY },
        presentation: { returnToWorld: () => {} },
        world: { isOrdering: () => false },
        gestureMaxAgeMs: 0,
      });
    } catch {
      // expected
    }
    return { registrations: input.totalRegistrations(), pending: time.pendingCount() };
  })();
  assert.deepEqual(probe, { registrations: 0, pending: 0 });
});

test("LF13. the existing press paths are intact: tap, Enter and Space each latch and are consumed fresh", () => {
  for (const press of [
    () => trusted.tap(),
    () => trusted.enterOnButton(),
    () => makeEvent("keydown", { key: " ", repeat: false, target: { tagName: "BUTTON" } }),
  ]) {
    const { time, input, lifecycle } = harness();
    input.dispatch(trusted.tap());
    lifecycle.consumeGesture();
    time.jumpBy(30_000);
    input.dispatch(press());
    time.advanceBy(250);
    assert.deepEqual(lifecycle.consumeGesture(), { phaseBefore: "RELEASED" });
  }
});

test("LF14. freshness is measured from the PRESS: a later drag or wheel does not extend it", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap());
  time.advanceBy(1_500);
  input.dispatch(trusted.drag());
  input.dispatch(trusted.touchSwipe());
  input.dispatch(trusted.wheel());
  time.advanceBy(1_000); // 2.5s since the press, 1s since the last drag/wheel
  assert.equal(lifecycle.consumeGesture(), null);
});

test("LF15. a stale latch is refused even when a later, unrelated input keeps the silence window alive", () => {
  const { time, input, lifecycle } = harness();
  input.dispatch(trusted.tap()); // the press whose click never arrives
  time.advanceBy(3_000);
  input.dispatch(trusted.hover()); // hover is not input at all
  input.dispatch(makeEvent("scroll"));
  assert.equal(lifecycle.consumeGesture(), null);
});

// ============================================================
// U4 Slice 2B, S3: onContextExpired - the 5-minute expiry hook
// ============================================================
//
// Fired once per expiry crossing, right after onPhase("CONTEXT_EXPIRED") and before
// HABITAT_IDLE and any wake; zero arguments; never awaited; throws and rejections
// are reported through onError; never after dispose(). The lifecycle holds no Domain
// handle and hands the hook nothing.

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function watchUnhandled() {
  const seen: unknown[] = [];
  const handler = (reason: unknown): void => void seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, stop: (): void => void process.off("unhandledRejection", handler) };
}

// A lifecycle that logs everything the timeline does into ONE ordered list.
function orderedLifecycle(options: { hook?: () => void | Promise<void>; onPhaseAlso?: (phase: InteractionPhase) => void } = {}) {
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const log: string[] = [];
  const lifecycle: ReturnType<typeof createExperienceLifecycle> = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => void log.push("returnToWorld") },
    world: { isOrdering: () => true },
    onPhase: (phase) => {
      log.push(`phase:${phase}`);
      options.onPhaseAlso?.(phase);
    },
    onWake: () => void log.push("wake"),
    onContextExpired: options.hook ? () => {
      log.push("hook");
      return options.hook!();
    } : () => void log.push("hook"),
  });
  lifecycle.start();
  return { time, input, lifecycle, log };
}

test("LX1. the hook fires once, exactly at 300s of silence: not at 299,999 ms, yes at 300,000 ms", () => {
  let calls = 0;
  const { time, input, lifecycle } = harness({ onContextExpired: () => void (calls += 1) });
  input.dispatch(trusted.tap());

  time.advanceBy(299_999);
  assert.equal(calls, 0);
  assert.equal(lifecycle.getPhase(), "RELEASED");

  time.advanceBy(1);
  assert.equal(calls, 1);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
});

test("LX2. it does not fire at boot, at 15s (SPACE_GIVEN), at 25s (RELEASED), or for any input", () => {
  let calls = 0;
  const { time, input, lifecycle } = harness({ onContextExpired: () => void (calls += 1) });
  assert.equal(calls, 0, "not at boot");
  time.advanceBy(3_600_000);
  assert.equal(calls, 0, "not while idle from boot");

  input.dispatch(trusted.tap());
  time.advanceBy(15_000);
  assert.equal(lifecycle.getPhase(), "SPACE_GIVEN");
  assert.equal(calls, 0, "not at 15s");
  time.advanceBy(10_000);
  assert.equal(lifecycle.getPhase(), "RELEASED");
  assert.equal(calls, 0, "not at 25s");
  input.dispatch(trusted.tap()); // input restarts the window: still no expiry
  time.advanceBy(299_999);
  assert.equal(calls, 0);
});

test("LX3. exactly once per crossing: repeated firing, late firing and an hour of silence never repeat it; a second customer's expiry fires it again", () => {
  let calls = 0;
  const { time, input } = harness({ onContextExpired: () => void (calls += 1) });
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  time.advanceBy(3_600_000);
  time.fireDue();
  time.fireDue();
  time.fireStale();
  assert.equal(calls, 1);

  input.dispatch(trusted.tap()); // a second customer
  time.advanceBy(300_000);
  assert.equal(calls, 2, "a new crossing, a new call");

  // A late timer: one overdue timeout catches up through every phase, still ONE expiry.
  input.dispatch(trusted.tap());
  time.jumpBy(600_000);
  time.fireDue();
  time.fireDue();
  assert.equal(calls, 3);
});

test("LX4. order: onPhase(CONTEXT_EXPIRED), then the hook, then HABITAT_IDLE (and returnToWorld), and the wake stays last", () => {
  const { time, input, log } = orderedLifecycle();
  input.dispatch(trusted.tap());
  log.length = 0;
  time.advanceBy(300_000);
  assert.deepEqual(log, ["phase:SPACE_GIVEN", "phase:RELEASED", "phase:CONTEXT_EXPIRED", "hook", "phase:HABITAT_IDLE", "returnToWorld"]);

  // The late-timer path: the input evaluates the missed silence first, so the expiry - and the hook - come BEFORE the wake.
  const late = orderedLifecycle();
  late.input.dispatch(trusted.tap());
  late.log.length = 0;
  late.time.jumpBy(360_000);
  late.input.dispatch(trusted.tap());
  assert.deepEqual(late.log, [
    "phase:SPACE_GIVEN",
    "phase:RELEASED",
    "phase:CONTEXT_EXPIRED",
    "hook",
    "phase:HABITAT_IDLE",
    "returnToWorld",
    "phase:ACTIVE_STANDBY",
    "wake",
  ]);
});

test("LX5. the hook is NOT awaited: a promise that never settles blocks nothing - Habitat is entered, the World returned, and the next wake works", () => {
  const { time, input, log, lifecycle } = orderedLifecycle({ hook: () => new Promise<void>(() => {}) });
  input.dispatch(trusted.tap());
  log.length = 0;
  time.advanceBy(300_000); // synchronous: everything below already happened
  assert.deepEqual(log.slice(-3), ["hook", "phase:HABITAT_IDLE", "returnToWorld"]);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");

  input.dispatch(trusted.tap());
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY");
  assert.equal(log.at(-1), "wake");
});

test("LX6. a synchronous throw from the hook is reported through onError and the timeline still completes (Habitat, World, wake)", () => {
  const boom = new Error("hook threw");
  const { time, input, lifecycle, errors, phases, calls } = harness({
    ordering: true,
    onContextExpired: () => {
      throw boom;
    },
  });
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);

  assert.deepEqual(errors, [boom]);
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  assert.deepEqual(phases.slice(-2), ["CONTEXT_EXPIRED", "HABITAT_IDLE"]);
  assert.equal(calls.returnToWorld, 1, "the existing Habitat behaviour is untouched by a failing hook");
  input.dispatch(trusted.tap());
  assert.equal(lifecycle.getPhase(), "ACTIVE_STANDBY", "and it still wakes");
});

test("LX7. a rejection - or a thenable that throws - is reported (never unhandled), and only asynchronously", async () => {
  const unhandled = watchUnhandled();
  try {
    for (const make of [
      () => Promise.reject(new Error("rejected")),
      () => Promise.reject(undefined),
      () => Promise.reject("just a string"),
      () => ({ then: () => { throw new Error("thenable threw"); } }) as unknown as Promise<void>,
    ]) {
      const { time, input, errors, lifecycle } = harness({ onContextExpired: make });
      input.dispatch(trusted.tap());
      time.advanceBy(300_000);
      assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
      assert.equal(errors.length, 0, "not reported synchronously: the hook is not awaited");
      await flushMicrotasks();
      assert.equal(errors.length, 1, "reported once, through onError");
    }
    await flushMicrotasks();
  } finally {
    unhandled.stop();
  }
  assert.deepEqual(unhandled.seen, [], "no unhandled rejection");
});

test("LX8. the hook is called with ZERO arguments: nothing about the transition, the phase, the snapshot or the Domain is handed over", () => {
  const argCounts: number[] = [];
  const { time, input } = harness({
    onContextExpired: function () {
      // eslint-disable-next-line prefer-rest-params
      argCounts.push(arguments.length);
    },
  });
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  assert.deepEqual(argCounts, [0]);
});

test("LX9. never after dispose: disposed before, disposed INSIDE onPhase(CONTEXT_EXPIRED), and disposed before a late input", () => {
  // (a) disposed before the expiry.
  {
    let calls = 0;
    const { time, input, lifecycle } = harness({ onContextExpired: () => void (calls += 1) });
    input.dispatch(trusted.tap());
    lifecycle.dispose();
    time.advanceBy(3_600_000);
    assert.equal(calls, 0);
  }
  // (b) disposed by the very phase callback that announces CONTEXT_EXPIRED: the timer only checks
  //     its own flag between transitions, so the lifecycle itself must refuse to call the hook.
  {
    const hookCalls: string[] = [];
    let lifecycle: ReturnType<typeof createExperienceLifecycle>;
    const time = createFakeTime();
    const input = createFakeInputTarget();
    lifecycle = createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => void hookCalls.push("returnToWorld") },
      world: { isOrdering: () => true },
      onPhase: (phase) => {
        hookCalls.push(`phase:${phase}`);
        if (phase === "CONTEXT_EXPIRED") lifecycle.dispose();
      },
      onContextExpired: () => void hookCalls.push("HOOK"),
    });
    lifecycle.start();
    input.dispatch(trusted.tap());
    hookCalls.length = 0;
    time.advanceBy(300_000);
    assert.equal(hookCalls.includes("HOOK"), false, "no hook after a dispose made by onPhase(CONTEXT_EXPIRED)");
    assert.equal(hookCalls.includes("returnToWorld"), false, "and nothing else of the disposed timeline ran");
  }
  // (c) disposed, then a late input arrives: the input is ignored, so no expiry is evaluated.
  {
    let calls = 0;
    const { time, input, lifecycle } = harness({ onContextExpired: () => void (calls += 1) });
    input.dispatch(trusted.tap());
    time.jumpBy(600_000);
    lifecycle.dispose();
    input.dispatch(trusted.tap());
    time.fireDue();
    assert.equal(calls, 0);
  }
  // (d) disposing FROM the hook itself is safe, and the hook still fired exactly once.
  {
    let calls = 0;
    let lifecycle: ReturnType<typeof createExperienceLifecycle>;
    const time = createFakeTime();
    const input = createFakeInputTarget();
    lifecycle = createExperienceLifecycle({
      clock: time.clock,
      scheduler: time.scheduler,
      inputTarget: input.target,
      snapshots: { getSnapshot: () => IDLE_READY },
      presentation: { returnToWorld: () => {} },
      world: { isOrdering: () => false },
      onContextExpired: () => {
        calls += 1;
        lifecycle.dispose();
      },
    });
    lifecycle.start();
    input.dispatch(trusted.tap());
    time.advanceBy(300_000);
    time.advanceBy(3_600_000);
    assert.equal(calls, 1);
  }
});

test("LX10. an expired context leaves the rest of the lifecycle exactly as it was: same phases, same wakes, same returnToWorld with or without a hook", () => {
  const run = (hook: (() => void) | undefined) => {
    const { time, input, phases, wakes, calls, lifecycle } = harness({ ordering: true, onContextExpired: hook });
    input.dispatch(trusted.tap());
    time.advanceBy(300_000);
    input.dispatch(trusted.tap());
    time.advanceBy(300_000);
    return JSON.stringify({ phases, wakes, returnToWorld: calls.returnToWorld, reads: calls.getSnapshot, phase: lifecycle.getPhase() });
  };
  assert.equal(run(() => {}), run(undefined));
});

test("LX11. the lifecycle itself reads no Domain snapshot at expiry (its only reads are the wakes'), whatever the hook does", () => {
  const { time, input, calls } = harness({ onContextExpired: () => {} });
  input.dispatch(trusted.tap()); // wake: 1 read
  const reads = calls.getSnapshot;
  time.advanceBy(300_000); // expiry: 0 reads by the lifecycle
  assert.equal(calls.getSnapshot, reads);
});

test("LX12. a hook that returns something odd, and an onError that itself throws, break nothing", () => {
  for (const value of [1, "x", null, undefined, {}, { then: 5 }]) {
    const { time, input, lifecycle } = harness({ onContextExpired: (() => value) as never });
    input.dispatch(trusted.tap());
    time.advanceBy(300_000);
    assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
  }
  const time = createFakeTime();
  const input = createFakeInputTarget();
  const lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
    onContextExpired: () => {
      throw new Error("hook");
    },
    onError: () => {
      throw new Error("the error hook itself is broken");
    },
  });
  lifecycle.start();
  input.dispatch(trusted.tap());
  assert.doesNotThrow(() => time.advanceBy(300_000));
  assert.equal(lifecycle.getPhase(), "HABITAT_IDLE");
});

test("LX13. when the hook runs the lifecycle is already resting in HABITAT_IDLE, and re-entering the lifecycle from the hook is safe", () => {
  const seen: string[] = [];
  let lifecycle: ReturnType<typeof createExperienceLifecycle>;
  const time = createFakeTime();
  const input = createFakeInputTarget();
  lifecycle = createExperienceLifecycle({
    clock: time.clock,
    scheduler: time.scheduler,
    inputTarget: input.target,
    snapshots: { getSnapshot: () => IDLE_READY },
    presentation: { returnToWorld: () => {} },
    world: { isOrdering: () => false },
    onContextExpired: () => {
      seen.push(lifecycle.getPhase());
      seen.push(String(lifecycle.consumeGesture()));
    },
  });
  lifecycle.start();
  input.dispatch(trusted.tap());
  time.advanceBy(300_000);
  assert.deepEqual(seen, ["HABITAT_IDLE", "null"]);
});
