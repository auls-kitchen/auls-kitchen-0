"use strict";

/**
 * Kiosk Catalog Service - the manifest -> revision -> verified cache flow.
 *
 *   1. Read the manifest (current revision).
 *   2. Read the local verified catalog (re-verified before use).
 *   3. Same revision            -> use the local catalog (no download).
 *   4. Otherwise                -> fetch the immutable snapshot, verify it,
 *                                  and only THEN persist it and return it.
 *
 * Offline / failure policy (decided for this scope): when the manifest
 * or snapshot cannot be obtained or verified, serve the last VERIFIED
 * local catalog (any age) marked STALE; with none, report UNAVAILABLE.
 * Unverified data is never returned and never persisted, and a failed
 * refresh never replaces the previous verified record.
 *
 * Result shapes:
 *   { status: "CURRENT", source: "cache" | "network", catalog, persisted? }
 *   { status: "STALE", reason, catalog }
 *   { status: "UNAVAILABLE", reason }
 * where catalog = { revision, products }.
 */

const { CATALOG_RECORD_SCHEMA_VERSION } = require("./catalogIndexedDbStore");
const contract = require("./catalogContract");
const integrity = require("./catalogIntegrity");

const CATALOG_STATUS = Object.freeze({
  CURRENT: "CURRENT",
  STALE: "STALE",
  UNAVAILABLE: "UNAVAILABLE",
});

const CACHE_STORE_ERROR = "CATALOG_STORE_ERROR";

function reasonOf(error) {
  return error && typeof error.code === "string" ? error.code : "UNKNOWN_ERROR";
}

/**
 * @param {Object} deps
 * @param {{fetchManifest: Function, fetchVerifiedSnapshot: Function}} deps.readPort
 * @param {{get: Function, put: Function}} deps.store - catalogIndexedDbStore (or same contract)
 * @param {() => number} [deps.now]
 * @param {SubtleCrypto} [deps.subtle]
 */
function createCatalogService(deps) {
  const safeDeps = deps || {};
  if (!safeDeps.readPort || typeof safeDeps.readPort.fetchManifest !== "function" || typeof safeDeps.readPort.fetchVerifiedSnapshot !== "function") {
    throw new TypeError("createCatalogService requires a `readPort` dependency");
  }
  if (!safeDeps.store || typeof safeDeps.store.get !== "function" || typeof safeDeps.store.put !== "function") {
    throw new TypeError("createCatalogService requires a `store` dependency");
  }
  const { readPort, store } = safeDeps;
  const now = safeDeps.now || (() => Date.now());

  /**
   * Returns the local catalog only if it is structurally valid AND its
   * integrity still verifies; anything else (missing, corrupted, store
   * failure) counts as "no usable local catalog".
   */
  async function readVerifiedLocal() {
    let record;
    try {
      record = await store.get();
    } catch (_error) {
      return { catalog: null, storeError: true };
    }
    if (!record || record.schemaVersion !== CATALOG_RECORD_SCHEMA_VERSION) {
      return { catalog: null, storeError: false };
    }
    try {
      const catalog = contract.parseSnapshot({ revision: record.revision, products: record.products }, record.revision);
      await integrity.verifySnapshotIntegrity(catalog, safeDeps.subtle);
      return { catalog, storeError: false };
    } catch (_error) {
      return { catalog: null, storeError: false };
    }
  }

  function fallback(local, reason) {
    if (local.catalog) {
      return { status: CATALOG_STATUS.STALE, reason, catalog: local.catalog };
    }
    return { status: CATALOG_STATUS.UNAVAILABLE, reason: local.storeError ? CACHE_STORE_ERROR + "+" + reason : reason };
  }

  async function load() {
    let manifest;
    let manifestError = null;
    try {
      manifest = await readPort.fetchManifest();
    } catch (error) {
      manifestError = error;
    }

    const local = await readVerifiedLocal();

    if (manifestError) {
      return fallback(local, reasonOf(manifestError));
    }

    if (local.catalog && local.catalog.revision === manifest.revision) {
      return { status: CATALOG_STATUS.CURRENT, source: "cache", catalog: local.catalog };
    }

    let snapshot;
    try {
      snapshot = await readPort.fetchVerifiedSnapshot(manifest);
    } catch (error) {
      return fallback(local, reasonOf(error));
    }

    // Verified - only now may it replace the stored catalog.
    let persisted = true;
    try {
      await store.put({
        schemaVersion: CATALOG_RECORD_SCHEMA_VERSION,
        revision: snapshot.revision,
        products: snapshot.products,
        verifiedAt: now(),
      });
    } catch (_error) {
      // The catalog is verified and usable for this session even if the
      // device could not store it; the previous record stays as it was.
      persisted = false;
    }
    return { status: CATALOG_STATUS.CURRENT, source: "network", catalog: snapshot, persisted };
  }

  let inFlight = null;

  return {
    /**
     * Concurrent calls share one in-flight load (no duplicate downloads).
     * Never rejects: every failure is reported through the result.
     */
    loadCatalog() {
      if (!inFlight) {
        inFlight = load().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

module.exports = { createCatalogService, CATALOG_STATUS, CACHE_STORE_ERROR };
