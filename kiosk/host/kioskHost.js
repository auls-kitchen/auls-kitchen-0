"use strict";

/**
 * Kiosk Host / Bootstrap (STEP 74) - the composition root that
 * constructs and wires the already-LOCKED Runtime (STEP 54-62) and the
 * already-implemented Experience layer (STEP 69-72) into one coherent
 * lifecycle, per the architecture discovered and approved at STEP 73.
 *
 * This module is COMPOSITION/LIFECYCLE GLUE ONLY. Unlike
 * experienceOrchestrator.js (which deliberately requires nothing from
 * kiosk/runtime/kiosk/persistence, since it receives already-built
 * instances via injection), this module IS the one place allowed to
 * require and construct kiosk/persistence, kiosk/runtime, and
 * kiosk/experience/* together - that is precisely what "composition
 * root" means, and is a different job from the Orchestrator's own pure
 * translation-boundary role.
 *
 * The Host holds no business logic of its own: it never calculates a
 * price, inspects stock, decides an order outcome, implements a
 * submission guard, implements a session rule, mutates Firestore
 * directly, generates an idempotency key, or interprets payment - every
 * one of those remains exactly where it already was (Runtime's own
 * LOCKED modules, or the Orchestrator's already-proven translation
 * rules). The Host's only state is a single bootstrap-status string and
 * the handful of constructed instances it composes - it never maintains
 * a second copy of Runtime's or the Orchestrator's own state.
 *
 * Auth is deliberately NOT implemented here. Host requires an injected
 * `auth` dependency shaped as:
 *   { resolveOwnerUid: () => Promise<string>, requestAuthReset?: () => Promise<void> }
 * A real production wiring would construct this from the Firebase Auth
 * SDK using the exact bootstrap shape already proven working elsewhere
 * in this repository (aul-pos.html: initializeApp -> getAuth ->
 * onAuthStateChanged -> signInAnonymously) - but that real wiring is a
 * separate, later scope. This module never imports Firebase itself,
 * keeping it fully testable with a fake `auth` and requiring no new
 * build/runtime toolchain.
 *
 * Bootstrap order enforced by this module's own API shape (not merely
 * documented): construction (persistence, Event Bus, Runtime,
 * Orchestrator) happens synchronously inside createKioskHost() and
 * returns the Orchestrator reference immediately - real consumers MUST
 * subscribe to `host.orchestrator` before ever calling the separate,
 * later, explicit `beginCustomerSession()` async method, which is the
 * ONLY thing that resolves ownerUid and calls hydrate(). There is no
 * way to hydrate through this API without the caller having already had
 * the opportunity to subscribe first.
 */

const { createPersistenceAdapter } = require("../persistence/persistenceAdapter");
const { createKioskRuntime } = require("../runtime/kioskRuntime");
const { createEventBus } = require("../experience/experienceEventBus");
const { createExperienceOrchestrator } = require("../experience/experienceOrchestrator");

const BootstrapStatus = Object.freeze({
  BOOTSTRAPPING: "BOOTSTRAPPING",
  READY: "READY",
  FAILED: "FAILED",
});

function createKioskHost(deps) {
  const safeDeps = deps || {};

  if (!safeDeps.store) {
    throw new TypeError("createKioskHost requires a `store` dependency ({get,set,delete})");
  }
  if (typeof safeDeps.callOrderIntent !== "function") {
    throw new TypeError("createKioskHost requires a `callOrderIntent` function dependency");
  }
  if (!safeDeps.auth || typeof safeDeps.auth.resolveOwnerUid !== "function") {
    throw new TypeError("createKioskHost requires an `auth` dependency with a resolveOwnerUid() function");
  }

  const auth = safeDeps.auth;

  // --- Construction (steps 1-4 of the LOCKED bootstrap order, STEP 73 S7) ---
  const persistence = createPersistenceAdapter(safeDeps.store);
  const eventBus = createEventBus();
  const runtime = createKioskRuntime({
    persistence,
    callOrderIntent: safeDeps.callOrderIntent,
    // Optional, forwarded verbatim - Host never decides WHEN Auth
    // rotation happens (that remains Session Machine's own guarded
    // sequence, STEP 59/73 S17); it only supplies the callback once.
    requestAuthReset: auth.requestAuthReset,
    stopInteraction: safeDeps.stopInteraction,
    neutralIdle: safeDeps.neutralIdle,
  });
  const orchestrator = createExperienceOrchestrator({ runtime, eventBus });

  // Host-level bootstrap status - DELIBERATELY separate from and never
  // conflated with ExperienceSnapshot.ready (STEP 74 S6). `ready` means
  // only "Runtime's hydrate() completed"; this status additionally
  // covers the Auth-resolution step that must happen BEFORE hydrate can
  // even be attempted, which `ready` cannot represent by definition.
  let bootstrapStatus = BootstrapStatus.BOOTSTRAPPING;

  function getBootstrapStatus() {
    return bootstrapStatus;
  }

  /**
   * Resolves the current customer's ownerUid via the injected `auth`
   * dependency and hydrates the (single, reused) Runtime/Orchestrator
   * against it. This is the ONLY place ownerUid is ever read by this
   * module, and it is never returned, stored, or exposed by this
   * function or any other Host API - only passed straight through to
   * orchestrator.hydrate(), exactly as STEP 73's Auth boundary requires.
   *
   * Safe to call again for a NEXT customer after a previous one's
   * session has ended (via host.orchestrator.endSession(...)) - the
   * SAME Runtime/Orchestrator/EventBus instances are reused; only
   * hydrate() re-baselines them under the newly-resolved identity
   * (STEP 73 S4/S12, proven at STEP 74 by the multi-session test below).
   *
   * Never claims READY on any failure - an Auth-resolution failure or a
   * hydrate failure both leave bootstrapStatus at FAILED, and
   * ExperienceSnapshot.ready is never asserted to be anything other than
   * whatever Runtime's own hydrate() actually produced (or its safe
   * pre-hydrate default of false, if hydrate was never reached at all).
   */
  async function beginCustomerSession(expiryOptions) {
    let ownerUid;
    try {
      ownerUid = await auth.resolveOwnerUid();
    } catch (_error) {
      bootstrapStatus = BootstrapStatus.FAILED;
      return { status: BootstrapStatus.FAILED, reason: "AUTH_RESOLUTION_FAILED" };
    }
    if (typeof ownerUid !== "string" || ownerUid.length === 0) {
      bootstrapStatus = BootstrapStatus.FAILED;
      return { status: BootstrapStatus.FAILED, reason: "AUTH_RESOLUTION_FAILED" };
    }

    let hydrateResult;
    try {
      hydrateResult = await orchestrator.hydrate(ownerUid, expiryOptions);
    } catch (_error) {
      bootstrapStatus = BootstrapStatus.FAILED;
      return { status: BootstrapStatus.FAILED, reason: "HYDRATE_FAILED" };
    }

    const snapshot = hydrateResult && hydrateResult.snapshot;
    bootstrapStatus = snapshot && snapshot.ready ? BootstrapStatus.READY : BootstrapStatus.FAILED;
    return { status: bootstrapStatus };
  }

  return Object.freeze({
    // The sole hand-off point for future consumers (Aul, UI) - they
    // subscribe and read state directly through this reference, never
    // through the Host itself (STEP 73 S9/S10 - Host is not a relay).
    orchestrator,
    beginCustomerSession,
    getBootstrapStatus,
  });
}

module.exports = { createKioskHost, BootstrapStatus };
