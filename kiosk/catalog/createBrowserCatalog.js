"use strict";

/**
 * Browser composition for the Kiosk Catalog Consumer Foundation.
 *
 * The minimal, non-invasive seam a later scope can call:
 *
 *   const catalog = createBrowserCatalog({ fetch: window.fetch.bind(window) });
 *   const result = await catalog.loadCatalog();   // CURRENT | STALE | UNAVAILABLE
 *
 * Composes the real Read Port (public Firebase Storage over HTTP), the
 * real dedicated IndexedDB catalog store and the Catalog Service. It is
 * NOT wired into createBrowserKiosk(), the Kiosk runtime/host, or the
 * production Experience entry - no UI or ordering behavior changes here.
 */

const { createCatalogReadPort } = require("./catalogReadPort");
const { createCatalogIndexedDbStore } = require("./catalogIndexedDbStore");
const { createCatalogService } = require("./catalogService");

/**
 * @param {Object} deps
 * @param {Function} deps.fetch - window.fetch (bound)
 * @param {string} [deps.bucket] - defaults to the production catalog bucket
 * @param {Object} [deps.dbConfig] - { dbName?, dbVersion? } (tests only)
 * @param {number} [deps.timeoutMs]
 */
function createBrowserCatalog(deps) {
  const safeDeps = deps || {};
  const readPort = createCatalogReadPort({
    fetch: safeDeps.fetch,
    bucket: safeDeps.bucket,
    timeoutMs: safeDeps.timeoutMs,
  });
  const store = createCatalogIndexedDbStore(safeDeps.dbConfig);
  return createCatalogService({ readPort, store });
}

module.exports = { createBrowserCatalog };
