"use strict";

/**
 * Kiosk Catalog Read Port - reads the Published Catalog from public
 * Firebase Storage and returns it only after it has been validated and
 * integrity-verified. No caching, no IndexedDB, no Firestore, no
 * Firebase SDK: plain HTTP GET through an injected `fetch`.
 *
 * Endpoint: the Firebase Storage download URL for the public catalog
 * objects (Storage Rules: /catalog/** public read; bucket CORS allows
 * https://kiosk.aulia.fun, GET/HEAD):
 *
 *   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<url-encoded object path>?alt=media
 *
 * Object paths come only from the contract: catalog/manifest.json, then
 * the snapshotPath the (validated) manifest names.
 */

const contract = require("./catalogContract");
const integrity = require("./catalogIntegrity");

const DEFAULT_CATALOG_BUCKET = "auls-kitchen.firebasestorage.app";
const DEFAULT_TIMEOUT_MS = 15000;

const { CatalogError, CATALOG_ERROR_CODES } = contract;

function objectUrl(bucket, objectPath) {
  return (
    "https://firebasestorage.googleapis.com/v0/b/" +
    encodeURIComponent(bucket) +
    "/o/" +
    encodeURIComponent(objectPath) +
    "?alt=media"
  );
}

/**
 * @param {Object} deps
 * @param {Function} deps.fetch - a WHATWG fetch (window.fetch in the browser)
 * @param {string} [deps.bucket] - Storage bucket; defaults to the production catalog bucket
 * @param {number} [deps.timeoutMs] - per-request timeout (only where AbortController exists)
 * @param {SubtleCrypto} [deps.subtle] - injectable WebCrypto (tests)
 */
function createCatalogReadPort(deps) {
  const safeDeps = deps || {};
  if (typeof safeDeps.fetch !== "function") {
    throw new TypeError("createCatalogReadPort requires a `fetch` function dependency");
  }
  const fetchFn = safeDeps.fetch;
  const bucket = safeDeps.bucket || DEFAULT_CATALOG_BUCKET;
  const timeoutMs = safeDeps.timeoutMs || DEFAULT_TIMEOUT_MS;

  async function getJson(objectPath, cacheMode, unavailableCode, malformedCode) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchFn(objectUrl(bucket, objectPath), {
        method: "GET",
        cache: cacheMode,
        signal: controller ? controller.signal : undefined,
      });
    } catch (_networkError) {
      throw new CatalogError(unavailableCode, "network request failed for " + objectPath);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response || !response.ok) {
      throw new CatalogError(unavailableCode, "HTTP " + (response ? response.status : "no response") + " for " + objectPath);
    }
    try {
      return await response.json();
    } catch (_parseError) {
      throw new CatalogError(malformedCode, "response for " + objectPath + " is not valid JSON");
    }
  }

  /**
   * @returns {Promise<{revision: string, snapshotPath: string}>}
   * @throws {CatalogError} MANIFEST_UNAVAILABLE | MANIFEST_MALFORMED
   */
  async function fetchManifest() {
    // The manifest is the one mutable pointer (Cache-Control: no-cache);
    // "no-store" makes sure a stale browser copy is never used.
    const raw = await getJson(
      contract.CATALOG_MANIFEST_OBJECT_PATH,
      "no-store",
      CATALOG_ERROR_CODES.MANIFEST_UNAVAILABLE,
      CATALOG_ERROR_CODES.MANIFEST_MALFORMED
    );
    return contract.parseManifest(raw);
  }

  /**
   * Fetches the immutable snapshot the manifest names, validates it and
   * verifies its integrity. Nothing is returned unless every check passed.
   *
   * @param {{revision: string, snapshotPath: string}} manifest - from fetchManifest()
   * @returns {Promise<{revision: string, products: object[]}>}
   * @throws {CatalogError}
   */
  async function fetchVerifiedSnapshot(manifest) {
    const objectPath = manifest.snapshotPath.replace(/^\//, "");
    // Immutable, content-addressed object: the default HTTP cache is fine.
    const raw = await getJson(
      objectPath,
      "default",
      CATALOG_ERROR_CODES.SNAPSHOT_UNAVAILABLE,
      CATALOG_ERROR_CODES.SNAPSHOT_MALFORMED
    );
    const snapshot = contract.parseSnapshot(raw, manifest.revision);
    await integrity.verifySnapshotIntegrity(snapshot, safeDeps.subtle);
    return snapshot;
  }

  return { fetchManifest, fetchVerifiedSnapshot };
}

module.exports = { createCatalogReadPort, objectUrl, DEFAULT_CATALOG_BUCKET };
