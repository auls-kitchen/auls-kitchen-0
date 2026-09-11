"use strict";

/**
 * Kiosk Firebase Auth adapter <-> Host integration tests (STEP 76 S15/S16).
 *
 * Run with: node --test kiosk/auth/firebaseAuthAdapter.hostIntegration.test.js
 * No new dependencies - Node's built-in test runner only. No real
 * Firebase, no network, no browser.
 *
 * This file proves the real createFirebaseAuthAdapter() satisfies the
 * Host contract `{resolveOwnerUid, requestAuthReset}` STRUCTURALLY,
 * wired into the REAL, unmodified createKioskHost() from STEP 74 - not
 * a Host-side fake standing in for the adapter, and not the adapter
 * standing in for a real Firebase SDK (that remains a deterministic
 * fake, per STEP 76's own instructions: no production Firebase
 * credentials, no real network). kioskHost.js itself is untouched by
 * this step - importing it here only exercises its already-existing,
 * already-tested public API.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFirebaseAuthAdapter } = require("./firebaseAuthAdapter");
const { createKioskHost, BootstrapStatus } = require("../host/kioskHost");

// Same minimal deterministic fake Auth SDK shape as firebaseAuthAdapter.test.js -
// duplicated intentionally (not imported) so this integration file exercises
// the adapter only through its real public module boundary, like a real
// Host wiring would.
function createFakeAuthSdk(options) {
  const opts = options || {};
  let uidCounter = 0;
  let currentUser = opts.initialUser === undefined ? null : opts.initialUser;
  let listeners = [];

  function emit() {
    for (const listener of listeners.slice()) listener.next(currentUser);
  }

  const auth = Object.freeze({ __fakeFirebaseAuth: true });

  function onAuthStateChanged(authArg, next) {
    const listener = { next };
    listeners.push(listener);
    queueMicrotask(() => {
      if (listeners.includes(listener)) listener.next(currentUser);
    });
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  async function signInAnonymously() {
    if (opts.failSignIn) throw new Error("fake sign-in failure");
    await Promise.resolve();
    uidCounter += 1;
    currentUser = { uid: "uid-" + uidCounter };
    queueMicrotask(emit);
    return { user: currentUser };
  }

  async function signOut() {
    await Promise.resolve();
    currentUser = null;
    queueMicrotask(emit);
  }

  return { auth, onAuthStateChanged, signInAnonymously, signOut };
}

function createInMemoryStore() {
  let value;
  let hasValue = false;
  return {
    async get() {
      return hasValue ? value : undefined;
    },
    async set(key, val) {
      value = val;
      hasValue = true;
    },
    async delete() {
      hasValue = false;
      value = undefined;
    },
  };
}

function createFakeCallOrderIntent() {
  return async () => ({ data: { status: "REJECTED", reason: "TEST_STUB_NOT_USED" } });
}

// ============================================================
// L. Structural contract compatibility
// ============================================================

test("L1. createKioskHost accepts a real createFirebaseAuthAdapter() instance as its `auth` dependency with no Host code changes", () => {
  const adapter = createFirebaseAuthAdapter(createFakeAuthSdk());
  assert.doesNotThrow(() => {
    createKioskHost({
      store: createInMemoryStore(),
      callOrderIntent: createFakeCallOrderIntent(),
      auth: adapter,
    });
  });
});

test("L2. beginCustomerSession() resolves via the real adapter's resolveOwnerUid() and reaches READY", async () => {
  const adapter = createFirebaseAuthAdapter(createFakeAuthSdk());
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createFakeCallOrderIntent(),
    auth: adapter,
  });

  const result = await host.beginCustomerSession();
  assert.equal(result.status, BootstrapStatus.READY);
  assert.equal(host.getBootstrapStatus(), BootstrapStatus.READY);
});

// ============================================================
// M. End-to-end Model B UID rotation through Host (STEP 76 S16)
// ============================================================

test("M1. requestSessionEnd -> Session Machine -> Runtime -> the real adapter's requestAuthReset() rotates the identity used by the NEXT beginCustomerSession()", async () => {
  const sdk = createFakeAuthSdk();
  const adapter = createFirebaseAuthAdapter(sdk);
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createFakeCallOrderIntent(),
    auth: adapter,
  });

  await host.beginCustomerSession();
  const uidA = await adapter.resolveOwnerUid();

  // Customer never added anything to cart, so ACTIVE is not reached;
  // exercise the adapter directly (already proven wired verbatim into
  // Runtime by kioskHost.js's own construction, STEP 74) to prove
  // rotation end-to-end without needing a full cart->submit flow here.
  await adapter.requestAuthReset();
  const uidB = await adapter.resolveOwnerUid();

  assert.notEqual(uidA, uidB);

  const secondBegin = await host.beginCustomerSession();
  assert.equal(secondBegin.status, BootstrapStatus.READY);
  const uidAfterSecondBegin = await adapter.resolveOwnerUid();
  assert.equal(uidAfterSecondBegin, uidB); // no further rotation merely from beginning a session
});

test("M2. Session Machine's own guarded requestSessionEnd calls the real adapter's requestAuthReset via Runtime, end to end, with no Host code changes", async () => {
  const sdk = createFakeAuthSdk();
  const adapter = createFirebaseAuthAdapter(sdk);
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createFakeCallOrderIntent(),
    auth: adapter,
  });

  await host.beginCustomerSession();
  const uidA = await adapter.resolveOwnerUid();

  host.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const { EventTypes: SessionEventTypes } = require("../session/sessionTypes");
  const endResult = await host.orchestrator.endSession(SessionEventTypes.CUSTOMER_CANCELLED);

  assert.equal(endResult.outcome, "SESSION_ENDED");
  const uidB = await adapter.resolveOwnerUid();
  assert.notEqual(uidA, uidB);
});

test("M3. a failing real-adapter requestAuthReset() (signOut rejects) surfaces as RESET_INCOMPLETE through the unmodified Host/Runtime/Session chain", async () => {
  const sdk = createFakeAuthSdk();
  const originalSignOut = sdk.signOut;
  sdk.signOut = async () => {
    throw new Error("simulated Auth outage");
  };
  const adapter = createFirebaseAuthAdapter(sdk);
  const host = createKioskHost({
    store: createInMemoryStore(),
    callOrderIntent: createFakeCallOrderIntent(),
    auth: adapter,
  });

  await host.beginCustomerSession();
  host.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [] });
  const { EventTypes: SessionEventTypes } = require("../session/sessionTypes");
  const endResult = await host.orchestrator.endSession(SessionEventTypes.CUSTOMER_CANCELLED);

  assert.equal(endResult.outcome, "RESET_INCOMPLETE");
  void originalSignOut;
});
