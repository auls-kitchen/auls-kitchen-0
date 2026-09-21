// U4 Slice 2B (S2) tests for src/composition/contextTransitions.ts.
//
// The coordinator is pure and injected: it is handed a plain `release` function and
// knows nothing of the Domain. These tests drive it with controllable fakes and pin
// (CT1-CT16 and the extras below):
//   - the classifier: only an explicit RELEASED / NOTHING_TO_RELEASE is FRESH
//   - single-flight: the gate is up synchronously, joiners share ONE promise, ONE call
//   - settle order: afterSettle callbacks run after the verdict, in registration order
//   - never-reject: every failure is UNAVAILABLE, never retried, always offered to onError
//   - disposal: an already-running release is not cancelled, but nothing fires afterwards

import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyReleaseResult, createContextTransitions } from "../../src/composition/contextTransitions.ts";
import type { ContextTransitionEvent, ContextTransitions } from "../../src/composition/contextTransitions.ts";
import { importSpecifiers, scanSource, stripComments } from "./support/sourceScan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "src");
const SOURCE_PATH = path.join(SRC_ROOT, "composition", "contextTransitions.ts");

// Every test in this file is bounded: a coordinator that never settles must FAIL its test
// (after 5s at the very latest), never stall the whole run.
const test = (name: string, fn: () => unknown): Promise<void> => nodeTest(name, { timeout: 5_000 }, fn);

// ---------------------------------------------------------------- helpers

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets every pending microtask (and Promise reaction) run.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Fails fast instead of hanging: a coordinator that never settles must fail the test, not stall the run.
async function settles<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the promise did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Every call of the injected `release` gets its own deferred, so a test decides when and how it settles.
function controlledRelease() {
  const invocations: Array<Deferred<unknown>> = [];
  const fn = (): Promise<unknown> => {
    const d = deferred<unknown>();
    invocations.push(d);
    return d.promise;
  };
  return { fn, invocations };
}

function harness(release?: () => Promise<unknown>) {
  const control = controlledRelease();
  const events: ContextTransitionEvent[] = [];
  const errors: unknown[] = [];
  const t = createContextTransitions({
    release: release ?? control.fn,
    onTransition: (event) => events.push(event as ContextTransitionEvent),
    onError: (error) => errors.push(error),
  });
  return { t, control, events, errors };
}

function watchUnhandledRejections() {
  const seen: unknown[] = [];
  const handler = (reason: unknown): void => void seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, stop: (): void => void process.off("unhandledRejection", handler) };
}

const RELEASED = Object.freeze({ outcome: "RELEASED", fromState: "ACTIVE", toState: "IDLE", callLog: Object.freeze(["guard"]) });
const NOTHING = Object.freeze({ outcome: "NOTHING_TO_RELEASE", fromState: "IDLE", callLog: Object.freeze(["guard"]) });
const REFUSED = Object.freeze({ outcome: "REFUSED", reason: "OUTCOME_UNRESOLVED", fromState: "AWAITING_OUTCOME", callLog: Object.freeze(["guard"]) });

// ============================================================
// Classification (CT1-CT5)
// ============================================================

test("CT1. classifier: RELEASED is FRESH", () => {
  assert.equal(classifyReleaseResult(RELEASED), "FRESH");
  assert.equal(classifyReleaseResult({ outcome: "RELEASED" }), "FRESH");
});

test("CT2. classifier: NOTHING_TO_RELEASE is FRESH (the Domain confirmed there is nothing to release)", () => {
  assert.equal(classifyReleaseResult(NOTHING), "FRESH");
  assert.equal(classifyReleaseResult({ outcome: "NOTHING_TO_RELEASE" }), "FRESH");
});

test("CT3. classifier: REFUSED is UNAVAILABLE, whatever the reason", () => {
  for (const reason of [
    "OUTCOME_UNRESOLVED",
    "NOT_HYDRATED",
    "PERSISTENCE_REMOVE_FAILED",
    "PERSISTENCE_READ_FAILED",
    "PERSISTED_ATTEMPT_PRESENT",
    "RELEASE_IN_PROGRESS",
    "STATE_CHANGED",
    undefined,
  ]) {
    assert.equal(classifyReleaseResult({ outcome: "REFUSED", reason }), "UNAVAILABLE", String(reason));
  }
  assert.equal(classifyReleaseResult(REFUSED), "UNAVAILABLE");
});

test("CT4. classifier: ORCHESTRATION_ERROR is UNAVAILABLE - and no invented BLOCKED vocabulary is FRESH", () => {
  assert.equal(classifyReleaseResult({ outcome: "ORCHESTRATION_ERROR" }), "UNAVAILABLE");
  for (const other of ["BLOCKED", "SESSION_ENDED", "RESET_INCOMPLETE", "SUCCESS", "OK", "FRESH", "UNAVAILABLE"]) {
    assert.equal(classifyReleaseResult({ outcome: other }), "UNAVAILABLE", other);
  }
});

test("CT5. classifier: any malformed result is UNAVAILABLE, and the classifier never throws", () => {
  const hostileGetter = {
    get outcome(): string {
      throw new Error("hostile getter");
    },
  };
  const hostileProxy = new Proxy({}, {
    get() {
      throw new Error("hostile proxy");
    },
  });
  const malformed: unknown[] = [
    null,
    undefined,
    "RELEASED",
    "NOTHING_TO_RELEASE",
    42,
    0,
    true,
    false,
    Symbol("RELEASED"),
    123n,
    [],
    [{ outcome: "RELEASED" }],
    {},
    { outcome: undefined },
    { outcome: null },
    { outcome: 5 },
    { outcome: true },
    { outcome: "released" },
    { outcome: "RELEASED " },
    { outcome: " RELEASED" },
    { outcome: "NOTHING_TO_RELEASE\n" },
    { outcome: ["RELEASED"] },
    { outcome: { toString: () => "RELEASED" } },
    { result: "RELEASED" },
    { status: "RELEASED" },
    Object.assign(() => "RELEASED", { outcome: "RELEASED" }), // a function is not a result object
    hostileGetter,
    hostileProxy,
  ];
  malformed.forEach((value, index) => {
    // The label is built from the index only: reading anything off a hostile value here would throw in the test itself.
    assert.doesNotThrow(() => classifyReleaseResult(value), `malformed[${index}] must not throw`);
    assert.equal(classifyReleaseResult(value), "UNAVAILABLE", `malformed[${index}]`);
  });
});

// ============================================================
// Never-reject contract (CT6, CT7, CT20)
// ============================================================

test("CT6. a synchronous throw from the injected release is UNAVAILABLE; onError observes it; the coordinator is free again", async () => {
  const boom = new Error("sync boom");
  let calls = 0;
  const { t, errors } = harness(() => {
    calls += 1;
    throw boom;
  });

  const verdict = await settles(t.release("EXPIRY"));

  assert.equal(verdict, "UNAVAILABLE");
  assert.deepEqual(errors, [boom], "the very error, not a fake success and not swallowed");
  assert.equal(calls, 1);
  assert.equal(t.isSettling(), false);
  assert.equal(await settles(t.release("EXPIRY")), "UNAVAILABLE", "still usable afterwards");
  assert.equal(calls, 2);
});

test("CT7. an asynchronous rejection from the injected release is UNAVAILABLE and offered to onError", async () => {
  const boom = new Error("async boom");
  const { t, control, errors } = harness();

  const promise = t.release("WAKE_RECONCILE");
  control.invocations[0]!.reject(boom);

  assert.equal(await settles(promise), "UNAVAILABLE");
  assert.deepEqual(errors, [boom]);
  assert.equal(t.isSettling(), false);
});

// ============================================================
// Single-flight (CT8-CT11)
// ============================================================

test("CT8. the first release raises the settling gate SYNCHRONOUSLY, before anything can await", async () => {
  const seenInsideInjected: boolean[] = [];
  const seenByStartedHook: boolean[] = [];
  const d = deferred<unknown>();
  let t: ContextTransitions;
  t = createContextTransitions({
    release: () => {
      seenInsideInjected.push(t.isSettling()); // the synchronous part of the injected function
      return d.promise;
    },
    onTransition: () => void seenByStartedHook.push(t.isSettling()),
  });
  assert.equal(t.isSettling(), false, "free before the first release");

  const promise = t.release("TAKEOVER");

  assert.equal(t.isSettling(), true, "up the instant release() returns - no await has happened");
  assert.deepEqual(seenInsideInjected, [true], "and already up while the injected function was starting");
  assert.deepEqual(seenByStartedHook, [true]);

  d.resolve(RELEASED);
  await promise;
  assert.equal(t.isSettling(), false, "down once settled");
});

test("CT9. concurrent release() calls invoke the injected release exactly once", async () => {
  const { t, control } = harness();

  const a = t.release("TAKEOVER");
  const b = t.release("EXPIRY");
  const c = t.release("WAKE_RECONCILE");
  const d = t.release("REBOOT_BOUNDARY");
  assert.equal(control.invocations.length, 1, "one injected call, however many callers");

  control.invocations[0]!.resolve(RELEASED);
  await settles(Promise.all([a, b, c, d]));
  assert.equal(control.invocations.length, 1, "and still one after settling");
});

test("CT10. every joined caller receives the same final verdict (FRESH and UNAVAILABLE)", async () => {
  for (const [result, expected] of [
    [RELEASED, "FRESH"],
    [NOTHING, "FRESH"],
    [REFUSED, "UNAVAILABLE"],
    [{ outcome: "ORCHESTRATION_ERROR" }, "UNAVAILABLE"],
    [undefined, "UNAVAILABLE"],
  ] as const) {
    const { t, control } = harness();
    const callers = [t.release("TAKEOVER"), t.release("EXPIRY"), t.release("WAKE_RECONCILE")];
    control.invocations[0]!.resolve(result);
    assert.deepEqual(await settles(Promise.all(callers)), [expected, expected, expected]);
  }
});

test("CT11. joiners observe the SAME Promise; a later release after settling gets a different one", async () => {
  const { t, control } = harness();

  const first = t.release("TAKEOVER");
  const joiner = t.release("EXPIRY");
  const another = t.release("REBOOT_BOUNDARY");
  assert.strictEqual(joiner, first, "same identity, not merely an equal result");
  assert.strictEqual(another, first);

  control.invocations[0]!.resolve(RELEASED);
  await first;

  control.invocations.length; // the second release below starts a NEW operation
  const later = t.release("WAKE_RECONCILE");
  assert.notStrictEqual(later, first);
  assert.equal(control.invocations.length, 2);
  control.invocations[1]!.resolve(NOTHING);
  assert.equal(await later, "FRESH");
});

// ============================================================
// afterSettle (CT12-CT14)
// ============================================================

test("CT12. afterSettle callbacks run only AFTER the release settles, in registration order, once the coordinator is free", async () => {
  const { t, control } = harness();
  const log: string[] = [];
  const freeInside: boolean[] = [];

  const promise = t.release("EXPIRY");
  void promise.then((verdict) => log.push(`verdict:${verdict}`)); // the verdict is known before any callback
  t.afterSettle(() => {
    log.push("A");
    freeInside.push(!t.isSettling());
  });
  t.afterSettle(() => log.push("B"));
  t.afterSettle(() => log.push("C"));

  await flush();
  assert.deepEqual(log, [], "nothing runs while the release is still in flight");

  control.invocations[0]!.resolve(RELEASED);
  await promise;
  await flush();

  assert.deepEqual(log, ["verdict:FRESH", "A", "B", "C"]);
  assert.deepEqual(freeInside, [true], "a callback sees a coordinator that is already free");
});

test("CT13. an expiry continuation registered first runs before a later wake continuation - and the reverse when registered the other way", async () => {
  // (a) expiry awaits release() first, the wake registers afterSettle later.
  {
    const { t, control } = harness();
    const order: string[] = [];
    async function expiry(): Promise<void> {
      const verdict = await t.release("EXPIRY");
      order.push(`expiry:${verdict}`);
    }
    const done = expiry();
    t.afterSettle(() => order.push("wake"));
    control.invocations[0]!.resolve(RELEASED);
    await done;
    await flush();
    assert.deepEqual(order, ["expiry:FRESH", "wake"]);
  }
  // (b) it is registration order, not the caller's role: the wake registered first runs first.
  {
    const { t, control } = harness();
    const order: string[] = [];
    const promise = t.release("EXPIRY");
    t.afterSettle(() => order.push("wake"));
    void promise.then(() => order.push("expiry"));
    control.invocations[0]!.resolve(RELEASED);
    await promise;
    await flush();
    assert.deepEqual(order, ["wake", "expiry"]);
  }
});

test("CT14. a throwing callback does not corrupt the coordinator: later callbacks still run, onError observes it, and it is reusable", async () => {
  const { t, control, errors } = harness();
  const boom = new Error("callback boom");
  const ran: string[] = [];

  const promise = t.release("EXPIRY");
  t.afterSettle(() => ran.push("A"));
  t.afterSettle(() => {
    throw boom;
  });
  t.afterSettle(() => ran.push("C"));
  control.invocations[0]!.resolve(RELEASED);
  await promise;
  await flush();

  assert.deepEqual(ran, ["A", "C"], "the throw did not stop the callbacks around it");
  assert.deepEqual(errors, [boom]);
  assert.equal(t.isSettling(), false, "state is clean");

  const next = t.release("WAKE_RECONCILE"); // and a new release works normally
  assert.equal(control.invocations.length, 2);
  control.invocations[1]!.resolve(REFUSED);
  assert.equal(await next, "UNAVAILABLE");
});

// ============================================================
// Dispose (CT15, CT16)
// ============================================================

test("CT15. dispose drops pending callbacks and blocks future releases (the injected release is never called again)", async () => {
  const { t, control, events } = harness();
  const ran: string[] = [];

  const promise = t.release("EXPIRY");
  t.afterSettle(() => ran.push("before-dispose"));
  t.dispose();
  t.afterSettle(() => ran.push("after-dispose")); // dropped on arrival
  control.invocations[0]!.resolve(RELEASED);
  await promise;
  await flush();
  assert.deepEqual(ran, [], "pending and later callbacks are both dropped");

  const after = await settles(t.release("TAKEOVER"));
  assert.equal(after, "UNAVAILABLE", "a release after dispose is UNAVAILABLE");
  assert.equal(control.invocations.length, 1, "and never reaches the injected release");
  assert.deepEqual(events.map((e) => e.type), ["RELEASE_STARTED"], "no hook fires after dispose");

  assert.doesNotThrow(() => t.dispose(), "dispose is idempotent");
});

test("CT16. an already-running release is NOT cancelled by dispose: it settles, but nothing fires afterwards and nothing is left unhandled", async () => {
  const unhandled = watchUnhandledRejections();
  try {
    // Success after dispose.
    {
      const { t, control, events, errors } = harness();
      const ran: string[] = [];
      const promise = t.release("EXPIRY");
      t.afterSettle(() => ran.push("callback"));
      t.dispose();
      assert.equal(t.isSettling(), true, "the running release is still running");

      control.invocations[0]!.resolve(RELEASED);
      assert.equal(await promise, "FRESH", "its real verdict is still delivered to whoever holds the promise");
      await flush();

      assert.deepEqual(ran, [], "no post-dispose callback");
      assert.deepEqual(events, [{ type: "RELEASE_STARTED", cause: "EXPIRY" }], "and no SETTLED hook after dispose");
      assert.deepEqual(errors, []);
      assert.equal(t.isSettling(), false, "state settled cleanly");
      assert.equal(control.invocations.length, 1);
    }
    // Rejection after dispose: still UNAVAILABLE, still offered to onError (diagnostics are never swallowed), no callbacks.
    {
      const { t, control, events, errors } = harness();
      const ran: string[] = [];
      const late = new Error("late failure");
      const promise = t.release("WAKE_RECONCILE");
      t.afterSettle(() => ran.push("callback"));
      t.dispose();
      control.invocations[0]!.reject(late);
      assert.equal(await promise, "UNAVAILABLE");
      await flush();
      assert.deepEqual(ran, []);
      assert.deepEqual(errors, [late]);
      assert.deepEqual(events.map((e) => e.type), ["RELEASE_STARTED"]);
      assert.equal(t.isSettling(), false);
    }
  } finally {
    unhandled.stop();
  }
  assert.deepEqual(unhandled.seen, [], "no unhandled rejection");
});

// ============================================================
// Extras: no retry, reuse, first cause, never reject
// ============================================================

test("CT17. no retry: a failing injected release is called exactly once, however it fails", async () => {
  for (const make of [
    () => Promise.reject(new Error("no")),
    () => {
      throw new Error("no");
    },
    () => Promise.resolve(REFUSED),
    () => Promise.resolve(undefined),
  ]) {
    let calls = 0;
    const { t } = harness(() => {
      calls += 1;
      return make() as Promise<unknown>;
    });
    assert.equal(await settles(t.release("EXPIRY")), "UNAVAILABLE");
    await flush();
    await flush();
    assert.equal(calls, 1);
  }
});

test("CT18. once settled, the coordinator is available for a later release, which is independent of the earlier one", async () => {
  const { t, control } = harness();

  const first = t.release("EXPIRY");
  control.invocations[0]!.resolve(REFUSED);
  assert.equal(await first, "UNAVAILABLE");
  assert.equal(t.isSettling(), false);

  const second = t.release("WAKE_RECONCILE");
  assert.equal(t.isSettling(), true);
  assert.equal(control.invocations.length, 2, "a fresh injected call");
  control.invocations[1]!.resolve(RELEASED);
  assert.equal(await second, "FRESH", "not tainted by the earlier refusal");
});

test("CT19. the first cause stays active: a joiner's cause is reported, never substituted", async () => {
  const { t, control, events } = harness();

  const first = t.release("TAKEOVER");
  t.release("EXPIRY");
  t.release("REBOOT_BOUNDARY");
  control.invocations[0]!.resolve(RELEASED);
  await first;
  const later = t.release("WAKE_RECONCILE");
  control.invocations[1]!.resolve(NOTHING);
  await later;

  assert.deepEqual(events, [
    { type: "RELEASE_STARTED", cause: "TAKEOVER" },
    { type: "RELEASE_JOINED", cause: "TAKEOVER", joinedCause: "EXPIRY" },
    { type: "RELEASE_JOINED", cause: "TAKEOVER", joinedCause: "REBOOT_BOUNDARY" },
    { type: "RELEASE_SETTLED", cause: "TAKEOVER", verdict: "FRESH" },
    { type: "RELEASE_STARTED", cause: "WAKE_RECONCILE" },
    { type: "RELEASE_SETTLED", cause: "WAKE_RECONCILE", verdict: "FRESH" },
  ]);
});

test("CT20. release() never rejects and never leaves an unhandled rejection, whatever the injected function does", async () => {
  const unhandled = watchUnhandledRejections();
  try {
    const thenableThatThrows = { then: () => { throw new Error("thenable boom"); } };
    const modes: Array<[string, () => unknown, "FRESH" | "UNAVAILABLE"]> = [
      ["sync throw Error", () => { throw new Error("x"); }, "UNAVAILABLE"],
      ["sync throw undefined", () => { throw undefined; }, "UNAVAILABLE"],
      ["sync throw string", () => { throw "just a string"; }, "UNAVAILABLE"],
      ["reject Error", () => Promise.reject(new Error("x")), "UNAVAILABLE"],
      ["reject undefined", () => Promise.reject(undefined), "UNAVAILABLE"],
      ["reject null", () => Promise.reject(null), "UNAVAILABLE"],
      ["resolve undefined", () => Promise.resolve(undefined), "UNAVAILABLE"],
      ["resolve garbage", () => Promise.resolve("garbage"), "UNAVAILABLE"],
      ["resolve REFUSED", () => Promise.resolve(REFUSED), "UNAVAILABLE"],
      ["non-promise garbage", () => 12345, "UNAVAILABLE"],
      ["non-promise RELEASED", () => RELEASED, "FRESH"],
      ["throwing thenable", () => thenableThatThrows, "UNAVAILABLE"],
      ["resolve RELEASED", () => Promise.resolve(RELEASED), "FRESH"],
    ];
    for (const [label, make, expected] of modes) {
      const errors: unknown[] = [];
      const t = createContextTransitions({ release: make as () => Promise<unknown>, onError: (e) => errors.push(e) });
      let promise: Promise<unknown> | undefined;
      assert.doesNotThrow(() => {
        promise = t.release("EXPIRY");
      }, `${label}: release() itself must not throw`);
      await assert.doesNotReject(settles(promise!), label);
      assert.equal(await settles(promise!), expected, label);
      assert.equal(t.isSettling(), false, `${label}: settled cleanly`);
      if (expected === "UNAVAILABLE" && /throw|reject|thenable/.test(label)) {
        assert.equal(errors.length, 1, `${label}: the failure was offered to onError`);
      }
    }
    await flush();
  } finally {
    unhandled.stop();
  }
  assert.deepEqual(unhandled.seen, []);
});

test("CT21. re-entrancy: a call back into release() from inside the injected function joins the same operation", async () => {
  const d = deferred<unknown>();
  let inner: Promise<unknown> | undefined;
  let calls = 0;
  let t: ContextTransitions;
  t = createContextTransitions({
    release: () => {
      calls += 1;
      inner = t.release("EXPIRY"); // still inside the synchronous part of the first release
      return d.promise;
    },
  });

  const outer = t.release("TAKEOVER");
  assert.strictEqual(inner, outer, "the inner call joined instead of starting a second release");
  assert.equal(calls, 1);
  d.resolve(RELEASED);
  assert.equal(await outer, "FRESH");
});

test("CT22. afterSettle with NO release in flight runs on the next microtask - never synchronously - in registration order", async () => {
  const { t, control } = harness();
  const log: string[] = [];

  t.afterSettle(() => log.push("A"));
  t.afterSettle(() => log.push("B"));
  assert.deepEqual(log, [], "not synchronous");
  assert.equal(t.isSettling(), false);
  await flush();
  assert.deepEqual(log, ["A", "B"]);
  assert.equal(control.invocations.length, 0, "and it never triggers a release");
});

test("CT23. a callback may start the next release: the coordinator is already free when callbacks run", async () => {
  const { t, control } = harness();
  let started: Promise<unknown> | undefined;

  const first = t.release("EXPIRY");
  t.afterSettle(() => {
    started = t.release("WAKE_RECONCILE");
  });
  control.invocations[0]!.resolve(REFUSED);
  await first;
  await flush();

  assert.equal(control.invocations.length, 2, "the callback's release really started");
  assert.equal(t.isSettling(), true);
  control.invocations[1]!.resolve(RELEASED);
  assert.equal(await started, "FRESH");
});

test("CT24. invalid use is rejected up front and changes nothing", () => {
  for (const bad of [undefined, null, {}, { release: 5 }, { release: "fn" }, { release: null }]) {
    assert.throws(() => createContextTransitions(bad as never), TypeError, String(bad));
  }
  const { t } = harness();
  for (const bad of [undefined, null, 5, "cb", {}]) {
    assert.throws(() => t.afterSettle(bad as never), TypeError);
  }
  assert.equal(t.isSettling(), false);
});

// ============================================================
// Hooks: constants only, and never able to break the coordinator
// ============================================================

test("CT25. onTransition carries stable coordinator constants only - no result, no customer data, no error text, no Domain names", async () => {
  const { t, control, events } = harness();
  const promise = t.release("TAKEOVER");
  t.release("EXPIRY");
  control.invocations[0]!.resolve({
    outcome: "RELEASED",
    fromState: "CONFIRMATION",
    customerName: "Sari",
    notes: "less sugar",
    cart: [{ productId: "p1" }],
    callLog: ["guard", "persistencePrecheck", "removeAuthoritativeResult"],
  });
  await promise;

  assert.ok(events.length > 0);
  const CAUSES = ["TAKEOVER", "EXPIRY", "WAKE_RECONCILE", "REBOOT_BOUNDARY"];
  const TYPES = ["RELEASE_STARTED", "RELEASE_JOINED", "RELEASE_SETTLED"];
  for (const event of events) {
    assert.ok(TYPES.includes(event.type));
    for (const [key, value] of Object.entries(event)) {
      assert.ok(["type", "cause", "joinedCause", "verdict"].includes(key), `unexpected key ${key}`);
      assert.equal(typeof value, "string");
    }
    if ("cause" in event) assert.ok(CAUSES.includes(event.cause));
  }
  const serialized = JSON.stringify(events);
  for (const leak of ["Sari", "less sugar", "p1", "persistencePrecheck", "removeAuthoritativeResult", "CONFIRMATION", "releaseCustomerContext", "orchestrator"]) {
    assert.equal(serialized.includes(leak), false, `events must not carry ${leak}`);
  }
});

test("CT26. throwing hooks never break the coordinator: a throwing onTransition is reported, a throwing onError is ignored", async () => {
  const boom = new Error("hook boom");
  const errors: unknown[] = [];
  const d = deferred<unknown>();
  const t = createContextTransitions({
    release: () => d.promise,
    onTransition: () => {
      throw boom;
    },
    onError: (e) => {
      errors.push(e);
      throw new Error("the error hook itself is broken");
    },
  });

  const promise = t.release("EXPIRY");
  d.resolve(RELEASED);
  assert.equal(await promise, "FRESH", "the verdict is unaffected");
  assert.equal(t.isSettling(), false);
  assert.ok(errors.length >= 2 && errors.every((e) => e === boom), "each hook failure was offered to onError");
});

test("CT32. state is cleared BEFORE anything is signalled: the coordinator is already free inside the settled hook, and a hook may start the next release", async () => {
  const d = deferred<unknown>();
  const second = deferred<unknown>();
  const busyInsideSettledHook: boolean[] = [];
  let t: ContextTransitions;
  let nextRelease: Promise<unknown> | undefined;
  let calls = 0;
  t = createContextTransitions({
    release: () => {
      calls += 1;
      return calls === 1 ? d.promise : second.promise;
    },
    onTransition: (event) => {
      if ((event as ContextTransitionEvent).type !== "RELEASE_SETTLED") return;
      if (nextRelease !== undefined) return; // only the FIRST settle starts a follow-up (else every settle would chain another)
      busyInsideSettledHook.push(t.isSettling());
      nextRelease = t.release("WAKE_RECONCILE"); // would join the finished release if state were still held
    },
  });

  const first = t.release("EXPIRY");
  d.resolve(REFUSED);
  assert.equal(await settles(first), "UNAVAILABLE");

  assert.deepEqual(busyInsideSettledHook, [false], "free while the hook runs");
  assert.equal(calls, 2, "the hook's release really started a NEW operation");
  second.resolve(RELEASED);
  assert.equal(await settles(nextRelease as Promise<unknown>), "FRESH");
});

// ============================================================
// Shape and structure
// ============================================================

test("CT27. the API is exactly four members, frozen, and works detached from the object (no reliance on `this`)", async () => {
  const { t, control } = harness();
  assert.deepEqual(Object.keys(t).sort(), ["afterSettle", "dispose", "isSettling", "release"]);
  assert.ok(Object.isFrozen(t));

  const { release, isSettling, afterSettle, dispose } = t;
  const log: string[] = [];
  const promise = release("EXPIRY");
  assert.equal(isSettling(), true);
  afterSettle(() => log.push("cb"));
  control.invocations[0]!.resolve(RELEASED);
  assert.equal(await promise, "FRESH");
  await flush();
  assert.deepEqual(log, ["cb"]);
  dispose();
  assert.equal(await release("EXPIRY"), "UNAVAILABLE");
});

test("CT28. isSettling follows the in-flight release: false, true, false; and after a mid-flight dispose it stays true until the release settles", async () => {
  const { t, control } = harness();
  assert.equal(t.isSettling(), false);
  const promise = t.release("EXPIRY");
  assert.equal(t.isSettling(), true);
  t.dispose();
  assert.equal(t.isSettling(), true, "dispose does not cancel the running release");
  control.invocations[0]!.resolve(RELEASED);
  await promise;
  assert.equal(t.isSettling(), false);
});

test("CT29. the classifier is pure and total: repeatable, and it never mutates or retains its input", () => {
  const frozen = Object.freeze({ outcome: "RELEASED", callLog: Object.freeze(["a"]) });
  for (let i = 0; i < 3; i++) assert.equal(classifyReleaseResult(frozen), "FRESH");
  const touched: Array<string | symbol> = [];
  const spy = new Proxy({ outcome: "REFUSED" }, {
    get(target, property, receiver) {
      touched.push(property);
      return Reflect.get(target, property, receiver);
    },
    set() {
      throw new Error("must not write");
    },
    defineProperty() {
      throw new Error("must not define");
    },
    deleteProperty() {
      throw new Error("must not delete");
    },
  });
  assert.equal(classifyReleaseResult(spy), "UNAVAILABLE");
  assert.deepEqual(touched, ["outcome"], "it reads only `outcome`");
});

test("CT30. structural: the module imports nothing, names no Domain capability, and reads no clock, DOM, timer, storage or network", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = stripComments(source);

  assert.deepEqual(importSpecifiers(code), [], "no imports at all");
  assert.deepEqual(scanSource(SOURCE_PATH, source, SRC_ROOT), [], "the strictest (lifecycle-grade) scan finds nothing");

  for (const token of [
    "releaseCustomerContext",
    "orchestrator",
    "host",
    "snapshot",
    "getSnapshot",
    "document",
    "window",
    "setTimeout",
    "setInterval",
    "Date",
    "performance",
    "fetch",
    "indexedDB",
    "localStorage",
    "requestAnimationFrame",
  ]) {
    assert.equal(new RegExp(`\\b${token}\\b`).test(code), false, `the coordinator must not mention ${token}`);
  }
});

test("CT31. negative control: the structural checks would catch a coordinator that named the Domain method or read a clock", () => {
  const tainted = `export const x = (d) => { d.releaseCustomerContext(); return Date.now(); };`;
  const violations = scanSource(SOURCE_PATH, tainted, SRC_ROOT);
  assert.ok(violations.some((v) => v.detail === "releaseCustomerContext"));
  assert.ok(violations.some((v) => v.kind === "FORBIDDEN_CLOCK"));
});
