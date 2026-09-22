// Ambient module declarations for the real Firebase modular SDK, loaded by
// browser-only CDN ESM import (exactly as aul-pos.html already does in
// production) - no npm package exists for it in this repo, so no .d.ts
// ships with it. Scoped to production/ only - never touches src/ or any
// shared contract.
//
// (kiosk/browser/createBrowserKiosk.js - plain JS, no declarations of its
// own - is NOT declared here: relative-path `declare module` blocks are
// resolved per-importer, not per-declaring-file, so they cannot target a
// fixed relative specifier this way. See kioskBrowser.ts for the one,
// explicit, narrow untyped boundary that handles it instead.)
//
// Every value this entry never inspects (the Firebase App/Auth/Functions
// SDK instances themselves) is intentionally typed `unknown`, mirroring the
// same opaque-handle discipline KioskHostPort's own
// `releaseCustomerContext(): Promise<unknown>` already uses.

declare module "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js" {
  export function initializeApp(config: unknown): unknown;
}

declare module "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js" {
  export function getAuth(app: unknown): unknown;
  export function onAuthStateChanged(auth: unknown, next: (user: unknown) => void): () => void;
  export function signInAnonymously(auth: unknown): Promise<unknown>;
  export function signOut(auth: unknown): Promise<void>;
}

declare module "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js" {
  export function getFunctions(app: unknown, region?: string): unknown;
  export function httpsCallable(functionsInstance: unknown, name: string): (payload: unknown) => Promise<{ readonly data: unknown }>;
}
