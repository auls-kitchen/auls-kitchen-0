// e2e harness (TEST ONLY). Mounts the real Composition root over the real AWR
// modules and the REAL, unmodified Kiosk Host (built from kiosk/ SOURCE with a
// fake Firebase - no network, no emulator). window.__u3 is the only test-only
// global and exists only in this page.
//
// The Composition is handed a PROXIED host port: every access is counted, and
// any property outside {orchestrator.getSnapshot, orchestrator.subscribe,
// beginCustomerSession, getBootstrapStatus} throws and is recorded, so the e2e
// can prove the Composition never reaches any other Domain capability.

import { instrument } from "./instrument.ts"; // MUST stay the first import.
import { mountAulWorld } from "../../../src/composition/compositionRoot.ts";
import type { AulWorldHandle } from "../../../src/composition/compositionRoot.ts";
// Kiosk SOURCE (CommonJS, unmodified), bundled by esbuild:
import { createBrowserKiosk } from "../../../../kiosk/browser/createBrowserKiosk.js";
import { createIndexedDbStore } from "../../../../kiosk/persistence/indexedDbAdapter.js";
import { createPersistenceAdapter } from "../../../../kiosk/persistence/persistenceAdapter.js";

type CallableMode = "success" | "unknown" | "reject" | "hang";

const DB = Object.freeze({ dbName: "aulWorldAppE2E", storeName: "kioskCustomerContext", dbVersion: 1 });
const OWNER_UID = "uid-1"; // the first fake anonymous sign-in

// ---- controllable fake back end (the Kiosk's OrderIntent callable + auth) ----
const control = {
  mode: "success" as CallableMode,
  orderIntentCalls: 0,
  signInCalls: 0,
  signOutCalls: 0,
  hangRelease: null as null | (() => void),
  authGate: null as null | { promise: Promise<void>; release: () => void },
  authFails: false,
  resetCounters() {
    this.orderIntentCalls = 0;
    this.signInCalls = 0;
    this.signOutCalls = 0;
    this.hangRelease = null;
  },
};

function authoritativeFor(payload: any) {
  const items = (payload.items as any[]).map((item) => ({
    productId: item.productId,
    productName: "Kopi",
    quantity: item.quantity,
    unitPrice: 15000,
    lineTotal: 15000 * item.quantity,
    selectedModifiers: [],
  }));
  return {
    orderState: "VALIDATED",
    authoritativeTotal: items.reduce((sum, i) => sum + i.lineTotal, 0),
    items,
    customerName: payload.customerName ?? null,
    notes: payload.notes ?? null,
  };
}

async function callable(payload: any) {
  control.orderIntentCalls += 1;
  switch (control.mode) {
    case "success":
      return { data: authoritativeFor(payload) };
    case "unknown":
      throw { code: "internal" }; // cannot be proven a no-commit -> UNKNOWN
    case "reject":
      throw { code: "functions/failed-precondition", details: { code: "INSUFFICIENT_STOCK" } };
    case "hang":
      return new Promise((resolve) => {
        control.hangRelease = () => resolve({ data: authoritativeFor(payload) });
      });
  }
}

function createFakeFirebase() {
  let uidCounter = 0;
  let currentUser: { uid: string } | null = null;
  let listeners: Array<{ next: (u: unknown) => void }> = [];
  const emit = () => {
    for (const l of listeners.slice()) l.next(currentUser);
  };
  return {
    initializeApp: (config: unknown) => ({ __fakeApp: true, config }),
    getAuth: (app: unknown) => ({ __fakeAuth: true, app }),
    getFunctions: (app: unknown, region: string) => ({ __fakeFunctions: true, app, region }),
    onAuthStateChanged(_auth: unknown, next: (u: unknown) => void) {
      const listener = { next };
      listeners.push(listener);
      queueMicrotask(() => {
        if (listeners.includes(listener)) listener.next(currentUser);
      });
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    async signInAnonymously() {
      control.signInCalls += 1;
      if (control.authGate) await control.authGate.promise;
      if (control.authFails) throw new Error("auth service down");
      uidCounter += 1;
      currentUser = { uid: `uid-${uidCounter}` };
      queueMicrotask(emit);
      return { user: currentUser };
    },
    async signOut() {
      control.signOutCalls += 1;
      await Promise.resolve();
      currentUser = null;
      queueMicrotask(emit);
    },
    httpsCallable: () => callable,
  };
}

// ---- proxied Domain port: counts calls, throws on anything not allowed -------
function guard<T extends object>(name: string, allowed: string[], target: T, violations: string[]): T {
  return new Proxy(target, {
    get(t, property, receiver) {
      if (typeof property === "string" && !allowed.includes(property)) {
        violations.push(`${name}.${property}`);
        throw new Error(`${name}.${property} is not permitted for the Composition`);
      }
      return Reflect.get(t, property, receiver);
    },
  });
}

// ---- page state -------------------------------------------------------------
let handle: AulWorldHandle | null = null;
let backgroundSubmit: Promise<string> | null = null;
let currentHost: any = null;
let lastRoot: HTMLElement | null = null;
let phases: string[] = [];
let wakes: Array<{ route: string; pending: string }> = [];
let errors: string[] = [];
let violations: string[] = [];
let portCalls = { getSnapshot: 0, subscribe: 0, beginCustomerSession: 0, getBootstrapStatus: 0 };
let activeDomainSubscriptions = 0;
const timers = { pending: new Set<number>(), sets: 0, clears: 0 };

const scheduler = {
  set(callback: () => void, delayMs: number): unknown {
    timers.sets += 1;
    const id = window.setTimeout(() => {
      timers.pending.delete(id);
      callback();
    }, delayMs);
    timers.pending.add(id);
    return id;
  },
  clear(handleId: unknown): void {
    timers.clears += 1;
    timers.pending.delete(handleId as number);
    window.clearTimeout(handleId as number);
  },
};
const clock = { now: (): number => performance.now() };

function buildPort(host: any) {
  const orchestrator = host.orchestrator;
  return guard(
    "host",
    ["orchestrator", "beginCustomerSession", "getBootstrapStatus"],
    {
      orchestrator: guard(
        "host.orchestrator",
        ["getSnapshot", "subscribe"],
        {
          getSnapshot() {
            portCalls.getSnapshot += 1;
            return orchestrator.getSnapshot();
          },
          subscribe(listener: (event: { type: string }) => void) {
            portCalls.subscribe += 1;
            activeDomainSubscriptions += 1;
            const unsubscribe = orchestrator.subscribe(listener);
            let done = false;
            return () => {
              if (done) return;
              done = true;
              activeDomainSubscriptions -= 1;
              unsubscribe();
            };
          },
        },
        violations,
      ),
      beginCustomerSession() {
        portCalls.beginCustomerSession += 1;
        return host.beginCustomerSession();
      },
      getBootstrapStatus() {
        portCalls.getBootstrapStatus += 1;
        return host.getBootstrapStatus();
      },
    },
    violations,
  );
}

async function mount(options: { thresholds?: { spaceGivenMs: number; releasedMs: number; contextExpiredMs: number } } = {}) {
  if (handle) throw new Error("already mounted; dispose() first");
  control.resetCounters();
  phases = [];
  wakes = [];
  errors = [];
  violations = [];
  portCalls = { getSnapshot: 0, subscribe: 0, beginCustomerSession: 0, getBootstrapStatus: 0 };
  activeDomainSubscriptions = 0;

  currentHost = createBrowserKiosk({
    firebaseConfig: { apiKey: "fake-key", projectId: "fake-project" },
    firebase: createFakeFirebase(),
    dbConfig: DB,
  });

  const container = document.getElementById("app") as HTMLElement;
  handle = mountAulWorld({
    container,
    host: buildPort(currentHost),
    clock,
    scheduler,
    thresholds: options.thresholds,
    onPhase: (phase) => phases.push(phase),
    onWake: (decision) => wakes.push({ route: decision.route, pending: decision.pending }),
    onError: (error) => errors.push(String((error as Error)?.message ?? error)),
  });
  lastRoot = container.querySelector("[data-aul-world]");
  await handle.ready;
}

function summarize(snapshot: any) {
  return {
    ready: snapshot.ready,
    session: snapshot.session,
    cartLines: snapshot.cart.lines.length,
    orderStatus: snapshot.order.status,
    canRetryUnknown: snapshot.capabilities.canRetryUnknown,
    canRequestSessionEnd: snapshot.capabilities.canRequestSessionEnd,
  };
}

const api = {
  mount,
  dispose(): void {
    handle?.dispose();
    handle = null;
  },
  // Starts a mount and returns immediately with the handle exposed, so a test can dispose mid-init.
  mountWithoutWaiting(): void {
    if (handle) throw new Error("already mounted");
    control.resetCounters();
    currentHost = createBrowserKiosk({ firebaseConfig: { apiKey: "k", projectId: "p" }, firebase: createFakeFirebase(), dbConfig: DB });
    handle = mountAulWorld({ container: document.getElementById("app") as HTMLElement, host: buildPort(currentHost), clock, scheduler });
    lastRoot = document.querySelector("[data-aul-world]");
  },
  async readySettled(): Promise<string> {
    try {
      await handle!.ready;
      return "resolved";
    } catch (error) {
      return `rejected:${String((error as Error).message)}`;
    }
  },
  domainSettled: async (): Promise<void> => {
    await handle!.domainSettled;
  },
  getPhase: (): string => (handle ? handle.getPhase() : "NOT_MOUNTED"),

  // fake back end
  setMode(mode: CallableMode): void {
    control.mode = mode;
  },
  releaseHang(): void {
    control.hangRelease?.();
  },
  gateAuth(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    control.authGate = { promise, release };
  },
  failAuth(fails: boolean): void {
    control.authFails = fails;
  },
  releaseAuth(): void {
    control.authGate?.release();
    control.authGate = null;
  },
  async resetDb(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  },

  // TEST-ONLY driving of the real Domain (the Composition never does any of this)
  domain: {
    addItem(): void {
      currentHost.orchestrator.addItem({ productId: "p1", quantity: 1, selectedModifiers: [], displaySnapshot: { name: "Kopi", price: 15000 } });
    },
    clearCart(): void {
      currentHost.orchestrator.clearCart();
    },
    async submit(): Promise<string> {
      const result = await currentHost.orchestrator.submit();
      return result.outcome;
    },
    // Starts a submit without waiting (used with the "hang" mode so an order can
    // settle while the kiosk is in Habitat).
    submitBackground(): void {
      backgroundSubmit = currentHost.orchestrator.submit().then((result: { outcome: string }) => result.outcome);
    },
    async awaitBackgroundSubmit(): Promise<string> {
      return backgroundSubmit as Promise<string>;
    },
    snapshot: () => summarize(currentHost.orchestrator.getSnapshot()),
    async persisted() {
      const adapter = createPersistenceAdapter(createIndexedDbStore(DB));
      const loaded = await adapter.load(OWNER_UID);
      return {
        status: loaded.status,
        submissionStatus: loaded.submissionAttempt ? loaded.submissionAttempt.status : null,
        hasAuthoritativeResult: !!loaded.authoritativeResult,
      };
    },
  },

  events: () => ({ phases: [...phases], wakes: wakes.map((w) => ({ ...w })), errors: [...errors] }),
  counters: () => ({
    portCalls: { ...portCalls },
    violations: [...violations],
    activeDomainSubscriptions,
    orderIntentCalls: control.orderIntentCalls,
    signInCalls: control.signInCalls,
    signOutCalls: control.signOutCalls,
    pendingTimers: timers.pending.size,
    timerSets: timers.sets,
    timerClears: timers.clears,
    outstandingFrames: instrument.outstandingFrames(),
    rootListeners: lastRoot ? instrument.activeListenersOn(lastRoot) : [],
    rootRegistrationsEver: lastRoot ? instrument.totalRegistrationsOn(lastRoot) : 0,
    canvases: document.querySelectorAll("canvas").length,
    roots: document.querySelectorAll("[data-aul-world]").length,
    shells: document.querySelectorAll("[data-experience-shell]").length,
  }),
};

(window as any).__u3 = api;
(window as any).__u3Ready = true;
