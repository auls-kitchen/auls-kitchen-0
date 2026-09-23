// The one, explicit, narrow untyped boundary between this production entry
// and kiosk/browser/createBrowserKiosk.js (real, unmodified Kiosk source -
// plain JS, no type declarations of its own, and never given one here:
// nothing under kiosk/ is touched). `@ts-expect-error` isolates the
// boundary to this single import line and fails loudly if it ever stops
// being necessary (e.g. if Kiosk source someday ships its own types).
//
// The return type is declared as the SAME KioskHostPort compositionRoot.ts
// already defines and requires - so every call site of the wrapper below
// is fully type-checked against the real contract mountAulWorld expects,
// not a blanket `any`.

import type { KioskHostPort } from "../src/composition/compositionRoot.ts";

// @ts-expect-error - kiosk/ ships no type declarations; this is the one
// accepted untyped boundary (see module header).
import { createBrowserKiosk as createBrowserKioskUntyped } from "../../kiosk/browser/createBrowserKiosk.js";

export interface CreateBrowserKioskDeps {
  readonly firebaseConfig: unknown;
  readonly firebase: {
    readonly initializeApp: (config: unknown) => unknown;
    readonly getAuth: (app: unknown) => unknown;
    readonly getFunctions: (app: unknown, region?: string) => unknown;
    readonly onAuthStateChanged: (auth: unknown, next: (user: unknown) => void) => () => void;
    readonly signInAnonymously: (auth: unknown) => Promise<unknown>;
    readonly signOut: (auth: unknown) => Promise<void>;
    readonly httpsCallable: (functionsInstance: unknown, name: string) => (payload: unknown) => Promise<{ readonly data: unknown }>;
  };
  readonly dbConfig?: unknown;
}

export function createBrowserKiosk(deps: CreateBrowserKioskDeps): KioskHostPort {
  return createBrowserKioskUntyped(deps) as KioskHostPort;
}
