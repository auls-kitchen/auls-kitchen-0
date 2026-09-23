"use strict";

/**
 * Kiosk Experience event bus tests (STEP 70).
 *
 * Run with: node --test kiosk/experience/experienceEventBus.test.js
 * No new dependencies - Node's built-in test runner only. No Firebase,
 * no network, no DOM, no timers, no global singleton.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createEventBus } = require("./experienceEventBus");
const { createSessionStartedEvent, createSessionEndedEvent, createSubmissionStartedEvent } = require("./experienceEvents");

// ============================================================
// P. Listener subscription
// ============================================================

test("P1. a subscribed listener receives an emitted event", () => {
  const bus = createEventBus();
  const received = [];
  bus.subscribe((event) => received.push(event));

  const event = createSessionStartedEvent();
  bus.emit(event);

  assert.equal(received.length, 1);
  assert.equal(received[0], event);
});

test("P2. multiple listeners each independently receive the same event", () => {
  const bus = createEventBus();
  const receivedA = [];
  const receivedB = [];
  bus.subscribe((event) => receivedA.push(event));
  bus.subscribe((event) => receivedB.push(event));

  bus.emit(createSessionStartedEvent());

  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 1);
});

test("P3. subscribe() requires a function", () => {
  const bus = createEventBus();
  assert.throws(() => bus.subscribe("not a function"), TypeError);
  assert.throws(() => bus.subscribe(null), TypeError);
});

// ============================================================
// Q. Listener unsubscribe
// ============================================================

test("Q1. unsubscribe() stops further delivery to that listener only", () => {
  const bus = createEventBus();
  const receivedA = [];
  const receivedB = [];
  const unsubscribeA = bus.subscribe((event) => receivedA.push(event));
  bus.subscribe((event) => receivedB.push(event));

  bus.emit(createSessionStartedEvent());
  unsubscribeA();
  bus.emit(createSessionEndedEvent());

  assert.equal(receivedA.length, 1); // only the first event
  assert.equal(receivedB.length, 2); // both events
});

test("Q2. calling unsubscribe() twice is safe and a no-op the second time", () => {
  const bus = createEventBus();
  const received = [];
  const unsubscribe = bus.subscribe((event) => received.push(event));
  unsubscribe();
  unsubscribe(); // must not throw, must not affect anything
  bus.emit(createSessionStartedEvent());
  assert.equal(received.length, 0);
});

test("Q3. a listener unsubscribing itself during delivery does not affect the CURRENT emit()'s delivery list", () => {
  const bus = createEventBus();
  const receivedB = [];
  let unsubscribeA;
  unsubscribeA = bus.subscribe(() => {
    unsubscribeA();
  });
  bus.subscribe((event) => receivedB.push(event));

  bus.emit(createSessionStartedEvent());
  assert.equal(receivedB.length, 1); // B still received this emission

  bus.emit(createSessionEndedEvent());
  assert.equal(receivedB.length, 2); // A is now gone, B still receives
});

// ============================================================
// R. Listener ordering
// ============================================================

test("R1. emit A, B, C delivers to a single listener in exactly that order", () => {
  const bus = createEventBus();
  const received = [];
  bus.subscribe((event) => received.push(event.type));

  bus.emit(createSessionStartedEvent());
  bus.emit(createSubmissionStartedEvent());
  bus.emit(createSessionEndedEvent());

  assert.deepEqual(received, ["SESSION_STARTED", "SUBMISSION_STARTED", "SESSION_ENDED"]);
});

// ============================================================
// S. Listener isolation
// ============================================================

test("S1. a throwing listener does not prevent delivery to other listeners", () => {
  const bus = createEventBus();
  const receivedB = [];
  bus.subscribe(() => {
    throw new Error("listener A is broken");
  });
  bus.subscribe((event) => receivedB.push(event));

  assert.doesNotThrow(() => bus.emit(createSessionStartedEvent()));
  assert.equal(receivedB.length, 1);
});

test("S2. onListenerError hook is invoked with the error and the event when a listener throws", () => {
  const capturedErrors = [];
  const bus = createEventBus({
    onListenerError: (error, event) => capturedErrors.push({ error, event }),
  });
  bus.subscribe(() => {
    throw new Error("boom");
  });

  const event = createSessionStartedEvent();
  bus.emit(event);

  assert.equal(capturedErrors.length, 1);
  assert.equal(capturedErrors[0].error.message, "boom");
  assert.equal(capturedErrors[0].event, event);
});

test("S3. without an onListenerError hook, a thrown error is caught and discarded (documented policy), never re-thrown", () => {
  const bus = createEventBus();
  bus.subscribe(() => {
    throw new Error("boom, no hook supplied");
  });
  assert.doesNotThrow(() => bus.emit(createSessionStartedEvent()));
});

test("S4. a throwing onListenerError hook itself does not break delivery to remaining listeners", () => {
  const bus = createEventBus({
    onListenerError: () => {
      throw new Error("the hook itself is broken");
    },
  });
  const receivedB = [];
  bus.subscribe(() => {
    throw new Error("listener A is broken");
  });
  bus.subscribe((event) => receivedB.push(event));

  assert.doesNotThrow(() => bus.emit(createSessionStartedEvent()));
  assert.equal(receivedB.length, 1);
});

// ============================================================
// T. No global singleton
// ============================================================

test("T1. two createEventBus() instances are fully independent", () => {
  const busA = createEventBus();
  const busB = createEventBus();
  const receivedA = [];
  const receivedB = [];
  busA.subscribe((event) => receivedA.push(event));
  busB.subscribe((event) => receivedB.push(event));

  busA.emit(createSessionStartedEvent());

  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 0); // busB never saw busA's emission
  assert.equal(busA.listenerCount(), 1);
  assert.equal(busB.listenerCount(), 1);
});

// ============================================================
// U/V. Dependency boundary
// ============================================================

test("U1/V1. experienceEventBus.js requires nothing at all beyond its own definition", () => {
  const source = fs.readFileSync(path.join(__dirname, "experienceEventBus.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets, []);
  for (const forbiddenUsage of ["require(\"firebase", "indexedDB.", "httpsCallable(", "fetch(", "setTimeout(", "setInterval(", "document.", "window."]) {
    assert.equal(source.includes(forbiddenUsage), false, "must not actually use " + forbiddenUsage);
  }
});

test("V2. the bus holds no operational/business state beyond its own listener list - no exported internal state accessors exist", () => {
  const bus = createEventBus();
  assert.deepEqual(Object.keys(bus).sort(), ["emit", "listenerCount", "subscribe"]);
});
