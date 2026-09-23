"use strict";

/**
 * Kiosk Browser Composition Entry (STEP 80) - the single future browser
 * bundle entry point, implementing the composition root design LOCKED
 * at STEP 79/80.
 *
 * This module is COMPOSITION ONLY. It never calculates price, inspects
 * stock/HPP, generates an idempotency key, submits an order, decides
 * Session End, or decides Auth Reset timing - all of that remains
 * exactly where it already was (Cart/Submission/OrderIntent/Session
 * Machine, all LOCKED and untouched by this file).
 *
 * FIREBASE BOUNDARY (STEP 77/78/79 LOCKED): this repository has no
 * Firebase npm package, and production code loads the modular Firebase
 * SDK exclusively via browser-only CDN ESM imports - unusable from this
 * CommonJS module under `node --test`. Consequently this file never
 * imports Firebase itself. It receives a small `firebase` dependency
 * object containing exactly the real modular-SDK functions it needs
 * (`initializeApp`, `getAuth`, `getFunctions`, `onAuthStateChanged`,
 * `signInAnonymously`, `signOut`, `httpsCallable`), using their real,
 * documented call signatures. A production caller wires this the same
 * way aul-pos.html already does today:
 *
 *   import { initializeApp } from ".../firebase-app.js";
 *   import { getAuth, onAuthStateChanged, signInAnonymously, signOut }
 *     from ".../firebase-auth.js";
 *   import { getFunctions, httpsCallable } from ".../firebase-functions.js";
 *   const host = createBrowserKiosk({
 *     firebaseConfig,
 *     firebase: { initializeApp, getAuth, getFunctions, onAuthStateChanged, signInAnonymously, signOut, httpsCallable },
 *   });
 *
 * This module requires exactly three existing Kiosk modules
 * (kiosk/auth/firebaseAuthAdapter, kiosk/persistence/indexedDbAdapter,
 * kiosk/host/kioskHost) - all already LOCKED, none modified here. Every
 * other Kiosk domain (cart, submission, orderIntent, session, runtime,
 * experience) is reached only indirectly, through Host's own existing
 * internal composition - this file never requires any of them directly.
 *
 * NO SELF-BOOTSTRAP (STEP 79/80 LOCKED): this factory is synchronous,
 * constructs everything, and returns the unmodified Host object
 * immediately - it never resolves ownerUid, never hydrates, never calls
 * beginCustomerSession(), never subscribes anything, and never touches
 * the DOM. The caller MUST subscribe to the returned Host's
 * `orchestrator` before ever calling `host.beginCustomerSession()` -
 * this file does nothing to that end itself, preserving Host's own
 * already-structurally-enforced subscribe-before-hydrate guarantee
 * unchanged.
 *
 * No module-level mutable state exists here - every dependency
 * (`firebaseApp`, `auth`, `functionsInstance`, `store`, `authAdapter`,
 * `callOrderIntent`, `host`) lives only inside one call's closure.
 * Calling this factory twice produces two fully independent stacks.
 */

const firebaseAuthAdapterModule = require("../auth/firebaseAuthAdapter");
const persistenceModule = require("../persistence/indexedDbAdapter");
const kioskHostModule = require("../host/kioskHost");

const DEFAULT_FUNCTIONS_REGION = "us-central1";
const ORDER_INTENT_CALLABLE_NAME = "orderIntent";

const REQUIRED_FIREBASE_FUNCTIONS = [
  "initializeApp",
  "getAuth",
  "getFunctions",
  "onAuthStateChanged",
  "signInAnonymously",
  "signOut",
  "httpsCallable",
];

function isFunction(value) {
  return typeof value === "function";
}

function sanitizeConstructionError(_rawError, safeMessage) {
  // Deliberately does not forward the raw underlying error object/message
  // beyond this module (mirrors firebaseAuthAdapter.js's own STEP 76
  // sanitization convention) - only a generic, safe Error ever surfaces.
  return new Error("createBrowserKiosk: " + safeMessage);
}

/**
 * @param {Object} deps
 * @param {Object} deps.firebaseConfig - REQUIRED. Passed verbatim to
 *   firebase.initializeApp(). Never inspected or mutated here.
 * @param {Object} deps.firebase - REQUIRED. The small set of real
 *   modular Firebase SDK functions this module needs, injected so this
 *   file never imports Firebase itself. Every one of
 *   REQUIRED_FIREBASE_FUNCTIONS must be a function.
 * @param {string} [deps.functionsRegion] - OPTIONAL. Defaults to
 *   "us-central1", matching aul-pos.html's existing production
 *   precedent for its own callable region.
 * @param {Object} [deps.dbConfig] - OPTIONAL. Forwarded verbatim to
 *   createIndexedDbStore() ({dbName, storeName, dbVersion}) - the exact
 *   shape that module already supports; nothing new is invented.
 * @param {() => Promise<void>} [deps.stopInteraction] - OPTIONAL,
 *   forwarded verbatim to createKioskHost (already-supported hook).
 * @param {() => Promise<void>} [deps.neutralIdle] - OPTIONAL, forwarded
 *   verbatim to createKioskHost (already-supported hook).
 * @returns {ReturnType<typeof kioskHostModule.createKioskHost>} the
 *   UNMODIFIED Kiosk Host object - never wrapped, never wrapped in a
 *   facade, never missing any of its existing surface.
 */
function createBrowserKiosk(deps) {
  const safeDeps = deps || {};

  if (!safeDeps.firebaseConfig) {
    throw new TypeError("createBrowserKiosk requires a `firebaseConfig` dependency");
  }
  const firebase = safeDeps.firebase || {};
  for (const fnName of REQUIRED_FIREBASE_FUNCTIONS) {
    if (!isFunction(firebase[fnName])) {
      throw new TypeError("createBrowserKiosk requires a `firebase." + fnName + "` function dependency");
    }
  }

  const functionsRegion = safeDeps.functionsRegion || DEFAULT_FUNCTIONS_REGION;

  let firebaseApp;
  let auth;
  let functionsInstance;
  try {
    firebaseApp = firebase.initializeApp(safeDeps.firebaseConfig);
    auth = firebase.getAuth(firebaseApp);
    functionsInstance = firebase.getFunctions(firebaseApp, functionsRegion);
  } catch (error) {
    throw sanitizeConstructionError(error, "Firebase infrastructure initialization failed");
  }

  let store;
  try {
    store = persistenceModule.createIndexedDbStore(safeDeps.dbConfig);
  } catch (error) {
    throw sanitizeConstructionError(error, "persistence construction failed");
  }

  let authAdapter;
  try {
    authAdapter = firebaseAuthAdapterModule.createFirebaseAuthAdapter({
      auth,
      onAuthStateChanged: firebase.onAuthStateChanged,
      signInAnonymously: firebase.signInAnonymously,
      signOut: firebase.signOut,
    });
  } catch (error) {
    throw sanitizeConstructionError(error, "Auth adapter construction failed");
  }

  let callOrderIntent;
  try {
    callOrderIntent = firebase.httpsCallable(functionsInstance, ORDER_INTENT_CALLABLE_NAME);
  } catch (error) {
    throw sanitizeConstructionError(error, "OrderIntent callable construction failed");
  }

  let host;
  try {
    host = kioskHostModule.createKioskHost({
      store,
      callOrderIntent,
      auth: authAdapter,
      stopInteraction: safeDeps.stopInteraction,
      neutralIdle: safeDeps.neutralIdle,
    });
  } catch (error) {
    throw sanitizeConstructionError(error, "Kiosk Host construction failed");
  }

  return host;
}

module.exports = { createBrowserKiosk, DEFAULT_FUNCTIONS_REGION };
