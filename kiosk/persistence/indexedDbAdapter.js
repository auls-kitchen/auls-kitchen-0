"use strict";

/**
 * IndexedDB-backed store for the Kiosk persistence adapter.
 *
 * IMPORTANT (disclosed, not hidden): this file is written against the
 * standard browser IndexedDB API and has NOT been executed in this
 * session - there is no browser runtime available in this environment,
 * and no dependency was added to fake one. It is exercised by ZERO
 * automated tests in this repository right now. `persistenceAdapter.js`
 * itself is fully unit-tested against a plain in-memory store that
 * satisfies the exact same {get,set,delete} contract this file also
 * implements - so the core domain logic is proven, but THIS file's
 * actual behavior against a real IndexedDB engine is not.
 *
 * No Firebase, no Firestore, no Cloud Functions, no OrderIntent, no
 * AWR/PixiJS, no payment provider dependency. The only global this file
 * touches is the browser's own `indexedDB`.
 *
 * IndexedDB remains RECOMMENDED, NOT LOCKED (STEP 53/55) - this file is
 * one possible concrete implementation of the {get,set,delete} contract
 * persistenceAdapter.js depends on; nothing about the domain logic
 * requires it specifically.
 */

const DEFAULT_DB_NAME = "aulKitchenKiosk";
const DEFAULT_STORE_NAME = "kioskPersistence";
const DEFAULT_DB_VERSION = 1;

/**
 * Creates a {get, set, delete} store backed by a single IndexedDB
 * object store. Opens (and, on first use, creates) the database lazily
 * on first operation; the connection is reused afterward.
 *
 * @param {Object} [config]
 * @param {string} [config.dbName]
 * @param {string} [config.storeName]
 * @param {number} [config.dbVersion]
 * @returns {{get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, delete: (key: string) => Promise<void>}}
 */
function createIndexedDbStore(config) {
  const dbName = (config && config.dbName) || DEFAULT_DB_NAME;
  const storeName = (config && config.storeName) || DEFAULT_STORE_NAME;
  const dbVersion = (config && config.dbVersion) || DEFAULT_DB_VERSION;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function withStore(mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const objectStore = tx.objectStore(storeName);
      const request = run(objectStore);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async get(key) {
      return withStore("readonly", (objectStore) => objectStore.get(key));
    },
    async set(key, value) {
      await withStore("readwrite", (objectStore) => objectStore.put(value, key));
    },
    async delete(key) {
      await withStore("readwrite", (objectStore) => objectStore.delete(key));
    },
  };
}

module.exports = { createIndexedDbStore, DEFAULT_DB_NAME, DEFAULT_STORE_NAME, DEFAULT_DB_VERSION };
