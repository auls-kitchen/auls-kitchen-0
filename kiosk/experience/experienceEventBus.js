"use strict";

/**
 * Kiosk Experience event bus (STEP 70) - a minimal, synchronous
 * publish/subscribe mechanism for the five semantic events defined in
 * experienceEvents.js. No I/O, no Firebase, no Firestore, no IndexedDB,
 * no network, no timers, no DOM, no requires of any kiosk/cart,
 * kiosk/persistence, kiosk/submission, kiosk/orderIntent, kiosk/session,
 * or kiosk/runtime module, and no requires at all beyond Node built-ins.
 *
 * This module knows NOTHING about Session/Submission/Order semantics -
 * it does not decide WHEN to emit anything, does not infer transitions,
 * does not detect retries/payments/stock, and does not mutate any event
 * it delivers. It is a delivery mechanism only; experienceEvents.js
 * decides what a valid event looks like, and a future orchestration
 * layer (not part of STEP 70) decides when to call emit().
 *
 * No global singleton: createEventBus() returns a fresh, independent
 * instance every call, with its listener list held in a closure - there
 * is no module-level mutable state of any kind.
 *
 * Deduplication policy (STEP 70 S11): NONE is implemented, and none is
 * needed at this layer - this bus delivers exactly what it is asked to
 * emit, in the order emit() is called, to whatever listeners are
 * currently subscribed. Deciding whether two emissions represent the
 * "same" meaningful change is an orchestration-layer concern (not yet
 * built), never this bus's job.
 *
 * Listener isolation policy (STEP 70 S9): each listener is called inside
 * its own try/catch. A throwing listener never prevents delivery to the
 * remaining listeners for that emit() call, and never mutates the event
 * (already frozen by experienceEvents.js) or any Runtime/operational
 * state (this module has no access to either). A caught error is
 * reported to the optional `onListenerError(error, event)` hook supplied
 * at bus-creation time; if no hook was supplied, the error is caught and
 * discarded - this module deliberately has no console/logging/telemetry
 * dependency of its own to report it through otherwise.
 */

function createEventBus(options) {
  const safeOptions = options || {};
  const onListenerError = typeof safeOptions.onListenerError === "function" ? safeOptions.onListenerError : null;

  let listeners = [];

  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("subscribe() requires a function listener");
    }
    listeners.push(listener);

    let stillSubscribed = true;
    return function unsubscribe() {
      if (!stillSubscribed) return;
      stillSubscribed = false;
      listeners = listeners.filter((existing) => existing !== listener);
    };
  }

  function emit(event) {
    // Snapshot the listener list at the moment of emission so a listener
    // that subscribes/unsubscribes DURING delivery cannot change who
    // receives THIS specific event - deterministic, order-preserving.
    const deliveryList = listeners.slice();
    for (const listener of deliveryList) {
      try {
        listener(event);
      } catch (error) {
        if (onListenerError) {
          try {
            onListenerError(error, event);
          } catch (_ignoredHookError) {
            // The error-reporting hook itself must never be allowed to
            // break delivery to the remaining listeners either.
          }
        }
      }
    }
  }

  function listenerCount() {
    return listeners.length;
  }

  return Object.freeze({ emit, subscribe, listenerCount });
}

module.exports = { createEventBus };
