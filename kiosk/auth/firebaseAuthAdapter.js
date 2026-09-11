"use strict";

/**
 * Kiosk Firebase Auth adapter (STEP 76) - the real infrastructure
 * implementation of the Auth contract Host has already declared and
 * depended on since STEP 73/74:
 *
 *   { resolveOwnerUid: () => Promise<string>, requestAuthReset: () => Promise<void> }
 *
 * This module is the ONLY place in kiosk/* allowed to know anything
 * about Firebase Auth's actual state-transition mechanics. Runtime,
 * Session Machine, the Orchestrator, and Host itself remain exactly as
 * LOCKED - none of them import this file, and this file does not import
 * any of them. It is wired in only via the `auth` dependency Host
 * already accepts.
 *
 * DEPENDENCY-INJECTION BOUNDARY (discovered this step, not assumed):
 * this repository has no Firebase npm package at all (no root
 * package.json, no node_modules/firebase). Production code
 * (aul-pos.html) loads the modular Firebase Auth SDK exclusively via
 * browser-only ESM `import` from gstatic CDN URLs - that mechanism does
 * not exist in Node's CommonJS `node --test` runner and cannot be
 * `require()`d here. Consequently this adapter does NOT call
 * `initializeApp`/`getAuth` itself - it receives an already-constructed
 * `auth` instance plus the three real modular-SDK functions
 * (`onAuthStateChanged`, `signInAnonymously`, `signOut`) as injected
 * dependencies, using exactly their real, documented call signatures
 * (`fn(auth, ...)`). A production caller wires this the same way
 * aul-pos.html already does today:
 *
 *   import { getAuth, onAuthStateChanged, signInAnonymously, signOut }
 *     from ".../firebase-auth.js";
 *   const auth = getAuth(firebaseApp);
 *   const authAdapter = createFirebaseAuthAdapter({ auth, onAuthStateChanged, signInAnonymously, signOut });
 *
 * No Firebase SDK object, no Firebase User object, and no raw Firebase
 * error ever leaves this module's public API - only a uid string (from
 * resolveOwnerUid) or void (from requestAuthReset), or a plain rejected
 * Error in either case. No persistence mode is ever set here
 * (`setPersistence` is never called) - the SDK's documented default
 * (browserLocalPersistence) is left untouched, matching STEP 75's
 * evidence-based recommendation; this adapter does not attempt to solve
 * or verify Kiosk-hardware reboot persistence.
 *
 * Auth infrastructure lifetime matches Host's lifetime: exactly one
 * `onAuthStateChanged` subscription is established once, at
 * construction, and reused across every Customer Session for as long as
 * this adapter instance lives - never re-subscribed per call.
 */

function isFunction(value) {
  return typeof value === "function";
}

function createFirebaseAuthAdapter(deps) {
  const safeDeps = deps || {};
  if (!safeDeps.auth) {
    throw new TypeError("createFirebaseAuthAdapter requires an `auth` dependency (the Firebase Auth instance)");
  }
  if (!isFunction(safeDeps.onAuthStateChanged)) {
    throw new TypeError("createFirebaseAuthAdapter requires an `onAuthStateChanged` function dependency");
  }
  if (!isFunction(safeDeps.signInAnonymously)) {
    throw new TypeError("createFirebaseAuthAdapter requires a `signInAnonymously` function dependency");
  }
  if (!isFunction(safeDeps.signOut)) {
    throw new TypeError("createFirebaseAuthAdapter requires a `signOut` function dependency");
  }

  const auth = safeDeps.auth;

  // currentUser: undefined = no onAuthStateChanged callback has fired
  // yet; null = observed signed-out; object = observed signed-in.
  let currentUser;
  let subscriptionError = null;

  // Single internal Auth-state coordination mechanism (STEP 76 S9): every
  // "wait for a specific Auth state" need (initial resolution, post-
  // signOut null, post-signInAnonymously non-null) goes through this one
  // waiter list, fed by the one persistent subscription below. No second
  // state machine is introduced.
  let waiters = [];

  function notifyUser(user) {
    currentUser = user;
    const stillWaiting = [];
    for (const waiter of waiters) {
      if (waiter.predicate(user)) {
        waiter.resolve(user);
      } else {
        stillWaiting.push(waiter);
      }
    }
    waiters = stillWaiting;
  }

  function notifyError(error) {
    subscriptionError = sanitizeError(error, "Auth state observation failed");
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter.reject(subscriptionError);
    }
  }

  function sanitizeError(_rawError, safeMessage) {
    // Deliberately does not forward the raw Firebase error object/message
    // beyond this module (STEP 76 S12/S18) - only a generic, safe Error.
    return new Error("firebaseAuthAdapter: " + safeMessage);
  }

  function waitForState(predicate) {
    return new Promise((resolve, reject) => {
      if (subscriptionError) {
        reject(subscriptionError);
        return;
      }
      if (currentUser !== undefined && predicate(currentUser)) {
        resolve(currentUser);
        return;
      }
      waiters.push({ predicate, resolve, reject });
    });
  }

  try {
    safeDeps.onAuthStateChanged(
      auth,
      (user) => notifyUser(user),
      (error) => notifyError(error)
    );
  } catch (error) {
    subscriptionError = sanitizeError(error, "Auth initialization failed");
  }

  function extractValidUid(user) {
    if (!user || typeof user.uid !== "string" || user.uid.length === 0) {
      return null;
    }
    return user.uid;
  }

  // Caches the in-flight/established resolveOwnerUid() outcome so
  // concurrent callers observe exactly one logical resolution (STEP 76
  // S10) rather than triggering redundant sign-ins. Invalidated after a
  // successful requestAuthReset() so the NEXT call reflects the new
  // identity - without re-triggering sign-in, since by then currentUser
  // is already the new non-null user (STEP 76 S16).
  let resolvePromise = null;

  function resolveOwnerUid() {
    if (resolvePromise) return resolvePromise;

    resolvePromise = (async () => {
      try {
        const initial = await waitForState(() => true);
        let user = initial;
        if (!user) {
          try {
            await safeDeps.signInAnonymously(auth);
          } catch (error) {
            throw sanitizeError(error, "anonymous sign-in failed");
          }
          user = await waitForState((candidate) => !!candidate);
        }
        const uid = extractValidUid(user);
        if (!uid) {
          throw sanitizeError(null, "resolved Auth state has no valid uid");
        }
        return uid;
      } catch (error) {
        resolvePromise = null; // allow a later call to retry
        throw error;
      }
    })();

    return resolvePromise;
  }

  // Serializes/dedups concurrent requestAuthReset() calls (STEP 76 S10):
  // two concurrent callers observe the outcome of the SAME single reset
  // operation rather than racing two independent identity rotations.
  let resetPromise = null;

  function requestAuthReset() {
    if (resetPromise) return resetPromise;

    resetPromise = (async () => {
      try {
        if (currentUser === undefined) {
          await waitForState(() => true);
        }
        const previousUid = extractValidUid(currentUser);

        try {
          await safeDeps.signOut(auth);
        } catch (error) {
          throw sanitizeError(error, "sign-out failed");
        }
        await waitForState((candidate) => candidate === null);

        try {
          await safeDeps.signInAnonymously(auth);
        } catch (error) {
          throw sanitizeError(error, "anonymous sign-in failed during reset");
        }
        const newUser = await waitForState((candidate) => !!candidate);

        const newUid = extractValidUid(newUser);
        if (!newUid) {
          throw sanitizeError(null, "reset produced an invalid uid");
        }
        if (previousUid !== null && newUid === previousUid) {
          // Model B requires a genuinely new identity after reset (STEP
          // 76 S8) - never report success if it is not.
          throw sanitizeError(null, "reset did not produce a new identity");
        }

        // A later resolveOwnerUid() must reflect the new identity, not a
        // memoized pre-reset uid.
        resolvePromise = null;
      } finally {
        resetPromise = null; // future resets remain possible regardless of outcome
      }
    })();

    return resetPromise;
  }

  return Object.freeze({ resolveOwnerUid, requestAuthReset });
}

module.exports = { createFirebaseAuthAdapter };
