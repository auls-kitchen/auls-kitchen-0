// Test support: drives the REAL, unmodified Kiosk Host/Runtime/Experience
// (kiosk/host/kioskHost.js and everything it composes) with in-memory fakes,
// so the Experience tests exercise genuine ExperienceSnapshots instead of
// hand-written ones. Read-only cross-package require of Kiosk SOURCE; nothing
// in kiosk/ is modified, and no Firebase, IndexedDB or network is involved.
//
// This file lives under test/ and is never part of src/, so the src-only
// import-boundary scan does not (and must not) apply to it.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { createKioskHost } = require("../../../../kiosk/host/kioskHost.js");

type Callable = (payload: unknown) => Promise<{ data: unknown }>;

interface KioskOrchestrator {
  getSnapshot(): any;
  addItem(input: unknown): unknown;
  clearCart(): unknown;
  submit(input?: unknown): Promise<any>;
  retryUnknown(): Promise<any>;
  endSession(eventType: string): Promise<any>;
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface KioskHostFixture {
  readonly host: { orchestrator: KioskOrchestrator; beginCustomerSession(): Promise<any> };
  readonly orchestrator: KioskOrchestrator;
  readonly store: Map<string, unknown>;
  // Additive (U2): counters proving the Domain was never driven by a timer.
  readonly calls: {
    readonly orderIntent: () => number;
    readonly resolveOwnerUid: () => number;
    readonly requestAuthReset: () => number;
  };
}

// A valid authoritative result, in the exact shape the backend's
// buildOrderIntentSafeResponse returns and the Kiosk adapter validates.
export function authoritativeResultFor(productId: string, quantity: number, unitPrice: number) {
  return {
    orderState: "VALIDATED",
    authoritativeTotal: unitPrice * quantity,
    items: [
      {
        productId,
        productName: "Kopi",
        quantity,
        unitPrice,
        lineTotal: unitPrice * quantity,
        selectedModifiers: [],
      },
    ],
    customerName: null,
    notes: null,
  };
}

export function succeedingCallable(): Callable {
  return async () => ({ data: authoritativeResultFor("p1", 1, 15000) });
}

// A transport failure the Kiosk cannot prove was a no-commit: classified UNKNOWN.
export function unknownCallable(): Callable {
  return async () => {
    throw { code: "internal" };
  };
}

// A backend rejection the Kiosk can prove was a no-commit: classified REJECTED.
export function rejectingCallable(): Callable {
  return async () => {
    throw { code: "failed-precondition", details: { code: "INSUFFICIENT_STOCK" } };
  };
}

export function createDeferredCallable(): { callable: Callable; release(): void; started(): boolean } {
  let resolveFn: (value: { data: unknown }) => void = () => {};
  let didStart = false;
  const callable: Callable = () =>
    new Promise((resolve) => {
      didStart = true;
      resolveFn = resolve;
    });
  return {
    callable,
    release: () => resolveFn({ data: authoritativeResultFor("p1", 1, 15000) }),
    started: () => didStart,
  };
}

export function createKioskHostFixture(callOrderIntent: Callable): KioskHostFixture {
  const store = new Map<string, unknown>();
  let orderIntentCalls = 0;
  let resolveOwnerUidCalls = 0;
  let requestAuthResetCalls = 0;
  const host = createKioskHost({
    store: {
      async get(key: string) {
        return store.has(key) ? structuredClone(store.get(key)) : null;
      },
      async set(key: string, value: unknown) {
        store.set(key, structuredClone(value));
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
    callOrderIntent: (payload: unknown) => {
      orderIntentCalls += 1;
      return callOrderIntent(payload);
    },
    auth: {
      resolveOwnerUid: async () => {
        resolveOwnerUidCalls += 1;
        return "uid-A";
      },
      requestAuthReset: async () => {
        requestAuthResetCalls += 1;
      },
    },
  });
  return {
    host,
    orchestrator: host.orchestrator,
    store,
    calls: {
      orderIntent: () => orderIntentCalls,
      resolveOwnerUid: () => resolveOwnerUidCalls,
      requestAuthReset: () => requestAuthResetCalls,
    },
  };
}

export const ITEM = Object.freeze({
  productId: "p1",
  quantity: 1,
  selectedModifiers: [],
  displaySnapshot: { name: "Kopi", price: 15000 },
});
