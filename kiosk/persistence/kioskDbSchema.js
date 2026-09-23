"use strict";

/**
 * Kiosk IndexedDB schema - the single source of truth for the database
 * name, version and object stores, shared by every IndexedDB-backed
 * Kiosk store (customer-context persistence and the Catalog store).
 *
 * Version history (additive only - an upgrade never deletes or rewrites
 * an existing object store or its records):
 *
 *   1  kioskPersistence  - customer-context record (STEP 53-56)
 *   2  kioskCatalog      - last verified Published Catalog Snapshot
 *                          (Kiosk Catalog Consumer Foundation)
 *
 * Every Kiosk store opens the database at the SAME version and runs the
 * SAME upgrade, so whichever store opens first performs the migration
 * and neither can fail the other with a VersionError.
 */

const KIOSK_DB_NAME = "aulKitchenKiosk";
const KIOSK_DB_VERSION = 2;
const PERSISTENCE_STORE_NAME = "kioskPersistence";
const CATALOG_STORE_NAME = "kioskCatalog";

/**
 * Creates every missing Kiosk object store. Safe to run on any old
 * version: existing stores (and their records) are left untouched.
 *
 * @param {IDBDatabase} db - the database passed to onupgradeneeded
 * @param {string[]} [extraStoreNames] - store names a caller configured
 *   explicitly (tests / non-default dbConfig); created if missing too.
 */
function ensureKioskObjectStores(db, extraStoreNames) {
  const names = [PERSISTENCE_STORE_NAME, CATALOG_STORE_NAME].concat(extraStoreNames || []);
  for (const name of names) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name);
    }
  }
}

module.exports = {
  KIOSK_DB_NAME,
  KIOSK_DB_VERSION,
  PERSISTENCE_STORE_NAME,
  CATALOG_STORE_NAME,
  ensureKioskObjectStores,
};
