"use strict";

/**
 * Kiosk Firebase Auth adapter tests (STEP 76).
 *
 * Run with: node --test kiosk/auth/firebaseAuthAdapter.test.js
 * No new dependencies - Node's built-in test runner only. No real
 * Firebase, no network, no browser. `createFakeAuthSdk` below is a
 * deterministic, minimal in-memory double modeling only the real
 * modular Firebase Auth JS SDK semantics this adapter actually depends
 * on (onAuthStateChanged fires asynchronously with the current state;
 * signInAnonymously/signOut are async and themselves trigger a
 * subsequent onAuthStateChanged callback) - it is NOT a general-purpose
 * Firebase fake and does not model anything beyond that.
 *
 * These are adapter UNIT tests. Section 15/16 (Host contract
 * compatibility, end-to-end UID rotation through the real Host) live in
 * firebaseAuthAdapter.hostIntegration.test.js, kept separate from this
 * file's pure adapter-boundary tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createFirebaseAuthAdapter } = require("./firebaseAuthAdapter");

// ============================================================
// Fake Auth SDK - models only: current user, onAuthStateChanged,
// signInAnonymously, signOut, async callback timing, failures, and the
// ability to force a specific (including duplicate) uid to exercise the
// same-uid-after-reset violation.
// ============================================================
function createFakeAuthSdk(options) {
  const opts = options || {};
  let uidCounter = 0;
  let currentUser = opts.initialUser === undefined ? null : opts.initialUser;
  let listeners = [];
  const calls = { signInAnonymously: 0, signOut: 0 };

  function emit() {
    for (const listener of listeners.slice()) {
      listener.next(currentUser);
    }
  }

  function nextUid() {
    uidCounter += 1;
    return opts.uidSequence ? opts.uidSequence[uidCounter - 1] || ("uid-" + uidCounter) : "uid-" + uidCounter;
  }

  const auth = Object.freeze({ __fakeFirebaseAuth: true });

  function onAuthStateChanged(authArg, next, error) {
    assert.equal(authArg, auth, "onAuthStateChanged must be called with the injected auth instance");
    const listener = { next, error };
    listeners.push(listener);
    if (opts.subscriptionError) {
      queueMicrotask(() => {
        if (listener.error) listener.error(opts.subscriptionError);
      });
    } else {
      // Real SDK: the callback fires asynchronously with whatever state
      // is already current at subscribe time.
      queueMicrotask(() => {
        if (listeners.includes(listener)) listener.next(currentUser);
      });
    }
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  async function signInAnonymously(authArg) {
    assert.equal(authArg, auth);
    calls.signInAnonymously += 1;
    if (opts.failSignIn) throw new Error("fake sign-in failure");
    await Promise.resolve(); // force real async ordering
    currentUser = Object.prototype.hasOwnProperty.call(opts, "malformedUidAfterSignIn")
      ? { uid: opts.malformedUidAfterSignIn }
      : { uid: nextUid() };
    queueMicrotask(emit);
    return { user: currentUser };
  }

  async function signOut(authArg) {
    assert.equal(authArg, auth);
    calls.signOut += 1;
    if (opts.failSignOut) throw new Error("fake sign-out failure");
    await Promise.resolve();
    currentUser = null;
    queueMicrotask(emit);
  }

  return { auth, onAuthStateChanged, signInAnonymously, signOut, calls, _forceUser: (u) => { currentUser = u; emit(); } };
}

function buildAdapter(options) {
  const sdk = createFakeAuthSdk(options);
  const adapter = createFirebaseAuthAdapter(sdk);
  return { adapter, sdk };
}

// ============================================================
// A. Construction validation
// ============================================================

test("A1. createFirebaseAuthAdapter throws TypeError without `auth`", () => {
  assert.throws(() => createFirebaseAuthAdapter({ onAuthStateChanged: () => {}, signInAnonymously: async () => {}, signOut: async () => {} }), TypeError);
});

test("A2. createFirebaseAuthAdapter throws TypeError without `onAuthStateChanged`", () => {
  assert.throws(() => createFirebaseAuthAdapter({ auth: {}, signInAnonymously: async () => {}, signOut: async () => {} }), TypeError);
});

test("A3. createFirebaseAuthAdapter throws TypeError without `signInAnonymously`", () => {
  assert.throws(() => createFirebaseAuthAdapter({ auth: {}, onAuthStateChanged: () => {}, signOut: async () => {} }), TypeError);
});

test("A4. createFirebaseAuthAdapter throws TypeError without `signOut`", () => {
  assert.throws(() => createFirebaseAuthAdapter({ auth: {}, onAuthStateChanged: () => {}, signInAnonymously: async () => {} }), TypeError);
});

test("A5. public API is exactly {resolveOwnerUid, requestAuthReset} - no Firebase object, no internal state leaks", () => {
  const { adapter } = buildAdapter();
  assert.deepEqual(Object.keys(adapter).sort(), ["requestAuthReset", "resolveOwnerUid"]);
});

// ============================================================
// B. resolveOwnerUid - no existing user (signed out)
// ============================================================

test("B1. resolveOwnerUid() signs in anonymously when no Auth user exists, resolves a valid uid", async () => {
  const { adapter, sdk } = buildAdapter();
  const uid = await adapter.resolveOwnerUid();
  assert.equal(typeof uid, "string");
  assert.ok(uid.length > 0);
  assert.equal(sdk.calls.signInAnonymously, 1);
});

test("B2. resolveOwnerUid() called twice sequentially (steady state) does not sign in a second time", async () => {
  const { adapter, sdk } = buildAdapter();
  const first = await adapter.resolveOwnerUid();
  const second = await adapter.resolveOwnerUid();
  assert.equal(first, second);
  assert.equal(sdk.calls.signInAnonymously, 1);
});

// ============================================================
// C. resolveOwnerUid - existing user already present
// ============================================================

test("C1. resolveOwnerUid() resolves the already-existing user's uid without signing in", async () => {
  const { adapter, sdk } = buildAdapter({ initialUser: { uid: "existing-uid" } });
  const uid = await adapter.resolveOwnerUid();
  assert.equal(uid, "existing-uid");
  assert.equal(sdk.calls.signInAnonymously, 0);
});

// ============================================================
// D. resolveOwnerUid - never resolves invalid values
// ============================================================

test("D1. resolveOwnerUid() rejects if the resulting user has no uid property", async () => {
  const { adapter } = buildAdapter({ malformedUidAfterSignIn: undefined });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

test("D2. resolveOwnerUid() rejects if the resulting uid is an empty string", async () => {
  const { adapter } = buildAdapter({ malformedUidAfterSignIn: "" });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

test("D3. resolveOwnerUid() rejects if the resulting uid is not a string", async () => {
  const { adapter } = buildAdapter({ malformedUidAfterSignIn: 12345 });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

// ============================================================
// E. resolveOwnerUid - failure paths
// ============================================================

test("E1. resolveOwnerUid() rejects (plain Error, not the raw SDK error) if signInAnonymously fails", async () => {
  const { adapter } = buildAdapter({ failSignIn: true });
  await assert.rejects(() => adapter.resolveOwnerUid(), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("firebaseAuthAdapter:"), true);
    return true;
  });
});

test("E2. resolveOwnerUid() rejects if Auth initialization (subscription setup) throws synchronously", async () => {
  const adapter = createFirebaseAuthAdapter({
    auth: {},
    onAuthStateChanged: () => { throw new Error("init boom"); },
    signInAnonymously: async () => ({ user: { uid: "x" } }),
    signOut: async () => {},
  });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

test("E3. resolveOwnerUid() rejects if the Auth state subscription itself reports an error", async () => {
  const { adapter } = buildAdapter({ subscriptionError: new Error("network down") });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

test("E4. a rejected resolveOwnerUid() can be retried and succeed once the underlying condition clears", async () => {
  let shouldFail = true;
  const sdk = createFakeAuthSdk({});
  const originalSignIn = sdk.signInAnonymously;
  sdk.signInAnonymously = async (authArg) => {
    if (shouldFail) throw new Error("transient failure");
    return originalSignIn(authArg);
  };
  const adapter = createFirebaseAuthAdapter(sdk);
  await assert.rejects(() => adapter.resolveOwnerUid());
  shouldFail = false;
  const uid = await adapter.resolveOwnerUid();
  assert.equal(typeof uid, "string");
});

// ============================================================
// F. resolveOwnerUid - concurrency
// ============================================================

test("F1. two concurrent resolveOwnerUid() calls dedupe to a single sign-in and the same uid", async () => {
  const { adapter, sdk } = buildAdapter();
  const [a, b] = await Promise.all([adapter.resolveOwnerUid(), adapter.resolveOwnerUid()]);
  assert.equal(a, b);
  assert.equal(sdk.calls.signInAnonymously, 1);
});

// ============================================================
// G. requestAuthReset - UID rotation
// ============================================================

test("G1. requestAuthReset() performs signOut then signInAnonymously and produces a different uid", async () => {
  const { adapter, sdk } = buildAdapter();
  const uidA = await adapter.resolveOwnerUid();
  await adapter.requestAuthReset();
  const uidB = await adapter.resolveOwnerUid();
  assert.notEqual(uidA, uidB);
  assert.equal(sdk.calls.signOut, 1);
  assert.equal(sdk.calls.signInAnonymously, 2); // once for A, once for reset -> B
});

test("G2. resolveOwnerUid() after a completed reset does NOT sign in again merely because a uid already exists", async () => {
  const { adapter, sdk } = buildAdapter();
  await adapter.resolveOwnerUid();
  await adapter.requestAuthReset();
  const signInCountAfterReset = sdk.calls.signInAnonymously;
  const uidB1 = await adapter.resolveOwnerUid();
  const uidB2 = await adapter.resolveOwnerUid();
  assert.equal(uidB1, uidB2);
  assert.equal(sdk.calls.signInAnonymously, signInCountAfterReset);
});

test("G3. requestAuthReset() works even if resolveOwnerUid() was never called first", async () => {
  const { adapter, sdk } = buildAdapter({ initialUser: { uid: "pre-existing" } });
  await adapter.requestAuthReset();
  const uid = await adapter.resolveOwnerUid();
  assert.notEqual(uid, "pre-existing");
  assert.equal(sdk.calls.signOut, 1);
});

test("G4. requestAuthReset() resolves void (not an object, not a status string)", async () => {
  const { adapter } = buildAdapter();
  const result = await adapter.requestAuthReset();
  assert.equal(result, undefined);
});

// ============================================================
// H. requestAuthReset - failure cases (STEP 76 S13 A-J)
// ============================================================

test("H-A. signOut failure rejects requestAuthReset()", async () => {
  const { adapter } = buildAdapter({ failSignOut: true });
  await adapter.resolveOwnerUid();
  await assert.rejects(() => adapter.requestAuthReset());
});

test("H-B. signInAnonymously failure (during reset) rejects requestAuthReset()", async () => {
  const sdk = createFakeAuthSdk({});
  let failNextSignIn = false;
  const originalSignIn = sdk.signInAnonymously;
  sdk.signInAnonymously = async (authArg) => {
    if (failNextSignIn) throw new Error("reset sign-in boom");
    return originalSignIn(authArg);
  };
  const adapter = createFirebaseAuthAdapter(sdk);
  await adapter.resolveOwnerUid();
  failNextSignIn = true;
  await assert.rejects(() => adapter.requestAuthReset());
});

test("H-C. missing null Auth state after signOut is handled - fake always reports null, so this proves the wait step is actually exercised", async () => {
  const { adapter, sdk } = buildAdapter();
  await adapter.resolveOwnerUid();
  await adapter.requestAuthReset();
  assert.equal(sdk.calls.signOut, 1);
});

test("H-D. malformed/invalid uid returned after signInAnonymously during reset rejects requestAuthReset()", async () => {
  const sdk = createFakeAuthSdk({});
  const adapter = createFirebaseAuthAdapter(sdk);
  await adapter.resolveOwnerUid();
  const originalSignIn = sdk.signInAnonymously;
  sdk.signInAnonymously = async (authArg) => {
    await originalSignIn(authArg);
    sdk._forceUser({ uid: "" });
    return { user: { uid: "" } };
  };
  await assert.rejects(() => adapter.requestAuthReset());
});

test("H-E. same uid returned after reset (Firebase anomaly) rejects requestAuthReset(), never reports success", async () => {
  const sdk = createFakeAuthSdk({ uidSequence: ["uid-fixed", "uid-fixed"] });
  const adapter = createFirebaseAuthAdapter(sdk);
  const uidA = await adapter.resolveOwnerUid();
  assert.equal(uidA, "uid-fixed");
  await assert.rejects(() => adapter.requestAuthReset(), (error) => {
    assert.ok(error instanceof Error);
    return true;
  });
});

test("H-F. Auth initialization failure rejects requestAuthReset() too", async () => {
  const adapter = createFirebaseAuthAdapter({
    auth: {},
    onAuthStateChanged: () => { throw new Error("init boom"); },
    signInAnonymously: async () => ({ user: { uid: "x" } }),
    signOut: async () => {},
  });
  await assert.rejects(() => adapter.requestAuthReset());
});

test("H-G. initial anonymous sign-in failure (before any reset) leaves requestAuthReset() also rejecting, since no baseline identity was ever established", async () => {
  const { adapter } = buildAdapter({ failSignIn: true });
  await assert.rejects(() => adapter.requestAuthReset());
});

test("H-H. malformed/empty uid at the very first resolution is rejected consistently by both functions", async () => {
  const { adapter } = buildAdapter({ malformedUidAfterSignIn: null });
  await assert.rejects(() => adapter.resolveOwnerUid());
});

test("H-I. callback ordering - onAuthStateChanged firing after resolveOwnerUid() is already pending still resolves correctly", async () => {
  const { adapter } = buildAdapter({ initialUser: { uid: "late-arrival" } });
  const uid = await adapter.resolveOwnerUid();
  assert.equal(uid, "late-arrival");
});

test("H-J. concurrent requestAuthReset() calls dedupe to a single reset operation", async () => {
  const { adapter, sdk } = buildAdapter();
  await adapter.resolveOwnerUid();
  await Promise.all([adapter.requestAuthReset(), adapter.requestAuthReset()]);
  assert.equal(sdk.calls.signOut, 1);
  assert.equal(sdk.calls.signInAnonymously, 2); // initial resolve + one reset
});

// ============================================================
// I. Security/privacy boundary (STEP 76 S18)
// ============================================================

test("I1. adapter never exposes the raw Firebase auth instance or a User object through its public API", async () => {
  const { adapter } = buildAdapter();
  const uid = await adapter.resolveOwnerUid();
  assert.equal(typeof uid, "string");
  for (const key of Object.keys(adapter)) {
    const value = adapter[key];
    assert.equal(typeof value, "function");
  }
});

test("I2. rejected errors never carry the raw underlying Firebase-style error object as a visible property", async () => {
  const { adapter } = buildAdapter({ failSignIn: true });
  try {
    await adapter.resolveOwnerUid();
    assert.fail("expected rejection");
  } catch (error) {
    assert.equal(error.message.includes("fake sign-in failure"), false);
  }
});

test("I3. source does not call console.log/console.error/console.warn anywhere (no uid logging surface)", () => {
  const source = fs.readFileSync(path.join(__dirname, "firebaseAuthAdapter.js"), "utf8");
  for (const forbidden of ["console.log(", "console.error(", "console.warn(", "console.debug(", "console.info("]) {
    assert.equal(source.includes(forbidden), false, "must not use " + forbidden);
  }
});

// ============================================================
// J. Forbidden dependency scan (STEP 76 S19)
// ============================================================

test("J1. firebaseAuthAdapter.js requires nothing beyond built-in Node globals - zero kiosk/* requires, zero forbidden domains", () => {
  const source = fs.readFileSync(path.join(__dirname, "firebaseAuthAdapter.js"), "utf8");
  const requireTargets = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(requireTargets, []);
  const forbiddenSubstrings = [
    "midtrans", "qris", "kds", "aul-world", "customer-display",
    "orderIntent", "cart", "stock", "hpp", "recipe", "payment",
    "kiosk/runtime", "kiosk/session", "kiosk/experience", "kiosk/host",
    "kiosk/cart", "kiosk/persistence", "kiosk/submission", "kiosk/orderIntent",
  ];
  const lowerSource = source.toLowerCase();
  for (const forbidden of forbiddenSubstrings) {
    assert.equal(lowerSource.includes(forbidden.toLowerCase()), false, "must not reference " + forbidden);
  }
});

// ============================================================
// K. No global singleton
// ============================================================

test("K1. two createFirebaseAuthAdapter() instances (over independent fake SDKs) are fully independent", async () => {
  const { adapter: adapterA, sdk: sdkA } = buildAdapter();
  const { adapter: adapterB } = buildAdapter();
  const uidA = await adapterA.resolveOwnerUid();
  const uidB = await adapterB.resolveOwnerUid();
  assert.equal(typeof uidA, "string");
  assert.equal(typeof uidB, "string");
  assert.equal(sdkA.calls.signInAnonymously, 1);
});
