// Production Kiosk Experience entry (D3 Step 1 - Production Experience Shell
// Boundary). The smallest real production bootstrap for the Composition:
//
//   real Firebase Auth/Functions (modular SDK, CDN ESM - the exact pattern
//   already proven in aul-pos.html) -> createBrowserKiosk (real, unmodified
//   Kiosk source) -> mountAulWorld (real, unmodified Composition root, which
//   itself reproduces AWR's own bootstrap without ever importing AWR's
//   main.ts - AWR stays frozen).
//
// Deliberately does NOT:
//   - read any Product Catalog (no such seam exists yet - later step)
//   - render any Menu/Product/Cart/Confirmation UI (later step)
//   - wire any Aul contextual response beyond what AWR already does on a
//     direct tap (later step)
//   - call addItem/submit/clearCart or any other Domain-mutating method
//   - proxy or fake anything: this is real Firebase, real IndexedDB, real
//     Kiosk Domain, exactly as a real customer's tablet would use
//
// Mounting alone performs only: Firebase init -> anonymous Auth resolution
// -> Kiosk Host bootstrap -> Runtime hydrate (a read of persistence/Domain
// state). None of this creates an order, mutates Product Master/stock, or
// touches payment - hydrate() only reads; nothing here ever calls submit().
//
// firebase.{initializeApp,getAuth,getFunctions,httpsCallable} are called by
// createBrowserKiosk ITSELF (its own documented contract - see
// kiosk/browser/createBrowserKiosk.js's header comment for the exact same
// dependency shape) - this file only supplies the real functions, never
// pre-constructs the app/auth/functions instances itself.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// The local, typed shim over real, unmodified Kiosk source (CommonJS,
// bundled by esbuild) - the exact same modules the e2e harness already
// builds from source, never from a stale gitignored kiosk/dist artifact.
import { createBrowserKiosk } from "./kioskBrowser.ts";

import { mountAulWorld } from "../src/composition/compositionRoot.ts";

// The same public, client-safe Firebase Web config already live in
// aul-pos.html's production bootstrap (Firebase Web API keys identify the
// project; they are not secrets - security is enforced by Firestore
// Rules/App Check/Auth, not by hiding this object).
const firebaseConfig = {
  apiKey: "AIzaSyB2498KtjyVe7pZ-RfPYvQybdJmlzUpqwg",
  authDomain: "auls-kitchen.firebaseapp.com",
  projectId: "auls-kitchen",
  storageBucket: "auls-kitchen.firebasestorage.app",
  messagingSenderId: "981577971183",
  appId: "1:981577971183:web:61148e193857035c94f21a",
};

// A dedicated IndexedDB database, distinct from the e2e harness's own
// "aulWorldAppE2E" - this is real customer-context persistence, never to be
// confused with or cleared by test infrastructure.
const DB = Object.freeze({ dbName: "aulKioskExperience", storeName: "kioskCustomerContext", dbVersion: 1 });

function report(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[AUL Kiosk]", error);
}

function main(): void {
  const container = document.getElementById("app");
  if (!container) throw new Error("production entry: #app container is missing");

  const host = createBrowserKiosk({
    firebaseConfig,
    firebase: { initializeApp, getAuth, getFunctions, onAuthStateChanged, signInAnonymously, signOut, httpsCallable },
    dbConfig: DB,
  });

  const handle = mountAulWorld({
    container,
    host,
    onError: report,
  });

  handle.ready.catch(report);
}

main();
