"use strict";

/**
 * Dedicated IndexedDB store for the last VERIFIED Published Catalog.
 *
 * Lives in the existing Kiosk database (aulKitchenKiosk) as its own
 * object store, kioskCatalog, created by the shared additive schema
 * upgrade (persistence/kioskDbSchema.js, version 2). It is completely
 * separate from kioskPersistence:
 *
 *   - never keyed by ownerUid (the catalog is device-level, not customer data)
 *   - never touched by cart / submission / authoritative-result resets,
 *     which only ever delete the kioskCustomerContext key in kioskPersistence
 *
 * One record under one fixed key. A put is a single IndexedDB
 * transaction and resolves only on transaction `complete`, so a reader
 * sees either the previous record or the new one - never a partial one.
 * Callers (catalogService.js) only ever put catalogs that already
 * passed integrity verification.
 */

const kioskDbSchema = require("../persistence/kioskDbSchema");

const CATALOG_RECORD_KEY = "verifiedCatalog";
const CATALOG_RECORD_SCHEMA_VERSION = 1;

/**
 * @param {Object} [config]
 * @param {string} [config.dbName] - test-scoped override; defaults to aulKitchenKiosk
 * @param {number} [config.dbVersion] - defaults to the shared schema version
 * @param {IDBFactory} [config.indexedDB] - defaults to the global indexedDB
 * @returns {{get: () => Promise<object|null>, put: (record: object) => Promise<void>}}
 */
function createCatalogIndexedDbStore(config) {
  const dbName = (config && config.dbName) || kioskDbSchema.KIOSK_DB_NAME;
  const dbVersion = (config && config.dbVersion) || kioskDbSchema.KIOSK_DB_VERSION;
  const storeName = kioskDbSchema.CATALOG_STORE_NAME;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    const factory = (config && config.indexedDB) || indexedDB;
    dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(dbName, dbVersion);
      request.onupgradeneeded = () => kioskDbSchema.ensureKioskObjectStores(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // A failed open must not poison every later attempt.
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  }

  return {
    async get() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).get(CATALOG_RECORD_KEY);
        request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async put(record) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(record, CATALOG_RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("catalog store transaction aborted"));
      });
    },
  };
}

module.exports = { createCatalogIndexedDbStore, CATALOG_RECORD_KEY, CATALOG_RECORD_SCHEMA_VERSION };
