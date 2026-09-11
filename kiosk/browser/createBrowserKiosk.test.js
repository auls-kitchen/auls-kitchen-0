"use strict";

/**
 * Kiosk Browser Composition Entry tests (STEP 80).
 *
 * Run with: node --test kiosk/browser/createBrowserKiosk.test.js
 * No new dependencies - Node's built-in test runner only. No real
 * Firebase, no browser, no real IndexedDB, no window/DOM. All Firebase
 * SDK primitives are deterministic in-memory fakes matching the real
 * modular SDK's documented call signatures (the same style already used
 * by kiosk/auth/firebaseAuthAdapter.test.js and
 * kiosk/auth/firebaseAuthAdapter.hostIntegration.test.js).
 *
 * A few tests monkey-patch a shared, already-required Kiosk module's
 * exported function for the duration of one call (capturing exact
 * construction args, then calling through to the REAL implementation,
 * then restoring it) - this proves exact wiring without ever modifying
 * kiosk/persistence/indexedDbAdapter.js or kiosk/host/kioskHost.js, and
 * without needing a real/faked global `indexedDB`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createBrowserKiosk, DEFAULT_FUNCTIONS_REGION } = require("./createBrowserKiosk");
const persistenceModule = require("../persistence/indexedDbAdapter");
const kioskHostModule = require("../host/kioskHost");

// ============================================================
// Fake Firebase SDK - models only the real modular-SDK call signatures
// this entry actually uses, with real async-callback timing for Auth.
// ============================================================
function createFakeFirebaseSdk(options) {
  const opts = options || {};
  let uidCounter = 0;
  let currentUser = opts.initialUser === undefined ? null : opts.initialUser;
  let listeners = [];
  const calls = { initializeApp: [], getAuth: [], getFunctions: [], httpsCallable: [], signInAnonymously: 0, signOut: 0 };

  function emit() {
    for (const listener of listeners.slice()) listener.next(currentUser);
  }

  function initializeApp(config) {
    calls.initializeApp.push(config);
    if (opts.failInitializeApp) throw new Error("fake initializeApp failure");
    return { __fakeFirebaseApp: true, config };
  }

  function getAuth(app) {
    calls.getAuth.push(app);
    if (opts.failGetAuth) throw new Error("fake getAuth failure");
    return { __fakeAuthInstance: true, app };
  }

  function getFunctions(app, region) {
    calls.getFunctions.push({ app, region });
    if (opts.failGetFunctions) throw new Error("fake getFunctions failure");
    return { __fakeFunctionsInstance: true, app, region };
  }

  function onAuthStateChanged(authArg, next, errorCb) {
    const listener = { next, error: errorCb };
    listeners.push(listener);
    queueMicrotask(() => {
      if (listeners.includes(listener)) listener.next(currentUser);
    });
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  async function signInAnonymously() {
    calls.signInAnonymously += 1;
    if (opts.failSignIn) throw new Error("fake sign-in failure");
    await Promise.resolve();
    uidCounter += 1;
    currentUser = { uid: "uid-" + uidCounter };
    queueMicrotask(emit);
    return { user: currentUser };
  }

  async function signOut() {
    calls.signOut += 1;
    await Promise.resolve();
    currentUser = null;
    queueMicrotask(emit);
  }

  function httpsCallable(functionsInstance, name) {
    calls.httpsCallable.push({ functionsInstance, name });
    if (opts.failHttpsCallableConstruction) throw new Error("fake httpsCallable construction failure");
    const callable = async (payload) => {
      callable.calls.push(payload);
      return { data: { status: "REJECTED", reason: "TEST_STUB_NOT_USED" } };
    };
    callable.calls = [];
    return callable;
  }

  return { initializeApp, getAuth, getFunctions, onAuthStateChanged, signInAnonymously, signOut, httpsCallable, calls };
}

function baseDeps(overrides) {
  const firebase = createFakeFirebaseSdk(overrides && overrides.sdkOptions);
  return Object.assign({ firebaseConfig: { apiKey: "fake-key", projectId: "fake-project" }, firebase }, overrides && overrides.deps);
}

function withSpy(moduleObj, methodName, fn) {
  const original = moduleObj[methodName];
  const calls = [];
  moduleObj[methodName] = function spy(...args) {
    calls.push(args);
    return original.apply(this, args);
  };
  try {
    return { result: fn(), calls };
  } finally {
    moduleObj[methodName] = original;
  }
}

// ============================================================
// A-C. Firebase App / Auth / Functions construction
// ============================================================

test("A. initializeApp receives the supplied firebaseConfig", () => {
  const firebaseConfig = { apiKey: "k1", projectId: "p1" };
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig, firebase });
  assert.equal(firebase.calls.initializeApp.length, 1);
  assert.equal(firebase.calls.initializeApp[0], firebaseConfig);
});

test("B. getAuth receives the created Firebase App", () => {
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.equal(firebase.calls.getAuth.length, 1);
  assert.equal(firebase.calls.getAuth[0].__fakeFirebaseApp, true);
});

test("C1. getFunctions receives the same Firebase App and the default region us-central1", () => {
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.equal(firebase.calls.getFunctions.length, 1);
  assert.equal(firebase.calls.getFunctions[0].app.__fakeFirebaseApp, true);
  assert.equal(firebase.calls.getFunctions[0].region, "us-central1");
  assert.equal(DEFAULT_FUNCTIONS_REGION, "us-central1");
});

test("C2. an explicit functionsRegion override is honored", () => {
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase, functionsRegion: "asia-southeast2" });
  assert.equal(firebase.calls.getFunctions[0].region, "asia-southeast2");
});

// ============================================================
// D. Auth adapter wiring (proven behaviorally, not by mocking the
// factory - the REAL createFirebaseAuthAdapter is always used)
// ============================================================

test("D. injected onAuthStateChanged/signInAnonymously reach the real Auth adapter - proven by beginCustomerSession triggering them", async () => {
  const firebase = createFakeFirebaseSdk();
  const host = createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  const result = await host.beginCustomerSession();
  // Auth resolution happens before hydrate and does not depend on a
  // working indexedDB - proven independently of whatever hydrate does.
  assert.notEqual(result.reason, "AUTH_RESOLUTION_FAILED");
  assert.equal(firebase.calls.signInAnonymously, 1);
});

// ============================================================
// E. IndexedDB store construction
// ============================================================

test("E. createIndexedDbStore is constructed with the expected configuration", () => {
  const firebase = createFakeFirebaseSdk();
  const dbConfig = { dbName: "customDb", storeName: "customStore", dbVersion: 3 };
  const { calls } = withSpy(persistenceModule, "createIndexedDbStore", () => {
    createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase, dbConfig });
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], dbConfig);
});

test("E2. the real, unmodified createIndexedDbStore remains constructible with no config (sanity check, no indexedDB touched)", () => {
  assert.doesNotThrow(() => persistenceModule.createIndexedDbStore());
});

// ============================================================
// F. httpsCallable construction
// ============================================================

test("F. httpsCallable is constructed with the Functions instance and \"orderIntent\"", () => {
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.equal(firebase.calls.httpsCallable.length, 1);
  assert.equal(firebase.calls.httpsCallable[0].functionsInstance.__fakeFunctionsInstance, true);
  assert.equal(firebase.calls.httpsCallable[0].name, "orderIntent");
});

// ============================================================
// G/H. Host construction + exact returned value
// ============================================================

test("G/H. createKioskHost receives store/callOrderIntent/auth, and the returned value IS that exact Host object", () => {
  const firebase = createFakeFirebaseSdk();
  const { result, calls } = withSpy(kioskHostModule, "createKioskHost", () => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }));
  assert.equal(calls.length, 1);
  const receivedDeps = calls[0][0];
  assert.equal(typeof receivedDeps.store.get, "function");
  assert.equal(typeof receivedDeps.store.set, "function");
  assert.equal(typeof receivedDeps.store.delete, "function");
  assert.equal(typeof receivedDeps.callOrderIntent, "function");
  assert.equal(typeof receivedDeps.auth.resolveOwnerUid, "function");
  assert.equal(typeof receivedDeps.auth.requestAuthReset, "function");
  assert.deepEqual(Object.keys(result).sort(), ["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
});

// ============================================================
// I/J. No self-bootstrap
// ============================================================

test("I. createBrowserKiosk does NOT call beginCustomerSession - bootstrap status is still BOOTSTRAPPING immediately after construction", () => {
  const firebase = createFakeFirebaseSdk();
  const host = createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.equal(host.getBootstrapStatus(), "BOOTSTRAPPING");
  assert.equal(firebase.calls.signInAnonymously, 0);
});

test("J. createBrowserKiosk does NOT hydrate - ExperienceSnapshot.ready is not true immediately after construction", () => {
  const firebase = createFakeFirebaseSdk();
  const host = createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  const snapshot = host.orchestrator.getSnapshot();
  assert.equal(snapshot.ready, false);
});

// ============================================================
// K/L. No leakage through the returned Host
// ============================================================

test("K. createBrowserKiosk does NOT expose ownerUid anywhere on the returned Host", async () => {
  const firebase = createFakeFirebaseSdk();
  const host = createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  await host.beginCustomerSession();
  const snapshotKeys = Object.keys(host.orchestrator.getSnapshot());
  for (const key of snapshotKeys) {
    assert.notEqual(key.toLowerCase(), "owneruid");
  }
  assert.deepEqual(Object.keys(host).sort(), ["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
});

test("L. createBrowserKiosk does NOT expose Firebase objects (app/auth/functions) on the returned Host", () => {
  const firebase = createFakeFirebaseSdk();
  const host = createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.deepEqual(Object.keys(host).sort(), ["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
  assert.deepEqual(Object.keys(host.orchestrator).sort(), [
    "addItem", "clearCart", "decrementLine", "endSession", "getSnapshot", "hydrate",
    "incrementLine", "removeLine", "retryUnknown", "setCustomerName", "setLineModifiers",
    "setNotes", "submit", "subscribe",
  ].sort());
});

// ============================================================
// M. No window globals
// ============================================================

test("M1. source never references `window.`", () => {
  const source = fs.readFileSync(path.join(__dirname, "createBrowserKiosk.js"), "utf8");
  assert.equal(source.includes("window."), false);
  assert.equal(source.includes("global.window"), false);
});

test("M2. construction does not create or mutate a global `window`", () => {
  const before = typeof globalThis.window;
  const firebase = createFakeFirebaseSdk();
  createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase });
  assert.equal(typeof globalThis.window, before);
});

// ============================================================
// N. Multi-Kiosk isolation
// ============================================================

test("N. two independent factory calls produce independent Host compositions with no shared state", async () => {
  const firebaseA = createFakeFirebaseSdk();
  const firebaseB = createFakeFirebaseSdk();
  const kioskA = createBrowserKiosk({ firebaseConfig: { apiKey: "a" }, firebase: firebaseA });
  const kioskB = createBrowserKiosk({ firebaseConfig: { apiKey: "b" }, firebase: firebaseB });

  assert.notEqual(kioskA, kioskB);
  assert.notEqual(kioskA.orchestrator, kioskB.orchestrator);

  kioskA.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  assert.equal(kioskA.orchestrator.getSnapshot().cart.lines.length, 1);
  assert.equal(kioskB.orchestrator.getSnapshot().cart.lines.length, 0);

  await kioskA.beginCustomerSession();
  await kioskB.beginCustomerSession();
  assert.equal(firebaseA.calls.signInAnonymously, 1);
  assert.equal(firebaseB.calls.signInAnonymously, 1);
});

// ============================================================
// O. Construction failure is safely surfaced (sanitized)
// ============================================================

test("O1. a Firebase App initialization failure throws a sanitized Error, never the raw underlying error", () => {
  const firebase = createFakeFirebaseSdk({ failInitializeApp: true });
  assert.throws(
    () => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("createBrowserKiosk:"), true);
      assert.equal(error.message.includes("fake initializeApp failure"), false);
      return true;
    }
  );
});

test("O2. a getAuth failure throws a sanitized Error", () => {
  const firebase = createFakeFirebaseSdk({ failGetAuth: true });
  assert.throws(() => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }), /createBrowserKiosk:/);
});

test("O3. a getFunctions failure throws a sanitized Error", () => {
  const firebase = createFakeFirebaseSdk({ failGetFunctions: true });
  assert.throws(() => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }), /createBrowserKiosk:/);
});

test("O4. an httpsCallable construction failure throws a sanitized Error", () => {
  const firebase = createFakeFirebaseSdk({ failHttpsCallableConstruction: true });
  assert.throws(() => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }), /createBrowserKiosk:/);
});

test("O5. missing firebaseConfig throws TypeError", () => {
  const firebase = createFakeFirebaseSdk();
  assert.throws(() => createBrowserKiosk({ firebase }), TypeError);
});

test("O6. a missing required firebase.* function throws TypeError", () => {
  const firebase = createFakeFirebaseSdk();
  delete firebase.signOut;
  assert.throws(() => createBrowserKiosk({ firebaseConfig: { apiKey: "k" }, firebase }), TypeError);
});

// ============================================================
// P. Deterministic, fake-only Firebase dependency injection
// ============================================================

test("P. no real Firebase, no network, no browser is ever touched - only injected fakes are used across this whole file", () => {
  const source = fs.readFileSync(path.join(__dirname, "createBrowserKiosk.js"), "utf8");
  for (const forbidden of ["gstatic.com", "firebasejs", "fetch(", "XMLHttpRequest"]) {
    assert.equal(source.includes(forbidden), false, "must not reference " + forbidden);
  }
});

// ============================================================
// Q/R/S. Source boundary scan
// ============================================================

test("Q/R/S. createBrowserKiosk.js has no Firestore/payment/QRIS/Midtrans/AWR/PixiJS reference and requires only the 3 intended kiosk modules", () => {
  const source = fs.readFileSync(path.join(__dirname, "createBrowserKiosk.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets.sort(), ["../auth/firebaseAuthAdapter", "../host/kioskHost", "../persistence/indexedDbAdapter"].sort());

  const lowerSource = source.toLowerCase();
  const forbiddenSubstrings = [
    "firestore", "midtrans", "qris", "kds", "payment",
    "aul-world-runtime", "pixi", "aul-world", "customer-display",
    "kiosk/cart", "kiosk/submission", "kiosk/session", "kiosk/orderintent", "kiosk/experience",
  ];
  for (const forbidden of forbiddenSubstrings) {
    assert.equal(lowerSource.includes(forbidden), false, "must not reference " + forbidden);
  }
});

test("T. the existing Host contract remains untouched - Host still throws the same validation errors it always did", () => {
  assert.throws(() => kioskHostModule.createKioskHost({}), TypeError);
  assert.deepEqual(Object.keys(kioskHostModule.BootstrapStatus).sort(), ["BOOTSTRAPPING", "FAILED", "READY"]);
});
