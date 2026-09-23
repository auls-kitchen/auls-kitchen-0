"use strict";

/**
 * Kiosk Catalog Read Port + Catalog Service tests.
 *
 * Run with: node --test kiosk/catalog/catalogService.test.js
 * A fake `fetch` serves fixtures (no network); an in-memory store
 * implements the same {get, put} contract as catalogIndexedDbStore.js.
 * The real IndexedDB store is exercised in the browser spec
 * (browser-test/catalog.browser.spec.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCatalogReadPort, objectUrl, DEFAULT_CATALOG_BUCKET } = require("./catalogReadPort");
const { createCatalogService, CATALOG_STATUS } = require("./catalogService");
const { buildCatalogPublishPlan } = require("../../functions/src/domain/catalogPublishPlan");
const liveManifest = require("./fixtures/catalogV1Manifest.json");
const liveSnapshot = require("./fixtures/catalogV1Snapshot.json");

const REV1 = liveManifest.revision;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A second, genuinely valid published catalog (built by the publisher's own plan). */
function buildRevision2() {
  const plan = buildCatalogPublishPlan([
    { id: "tea__lemon", name: "Lemon Tea", price: 6000, category: "tea", categoryLabel: "Fresh Tea Bar", categoryOrder: 5, itemOrder: 1 },
  ]);
  return {
    manifest: { revision: plan.revision, snapshotPath: "/catalog/" + plan.revision + ".json" },
    snapshot: JSON.parse(JSON.stringify({ revision: plan.revision, products: plan.products })),
  };
}

function manifestUrl() {
  return objectUrl(DEFAULT_CATALOG_BUCKET, "catalog/manifest.json");
}

function snapshotUrl(revision) {
  return objectUrl(DEFAULT_CATALOG_BUCKET, "catalog/" + revision + ".json");
}

/** fake fetch: routes = { url: body | Error | {status} }; records every request */
function createFakeFetch(routes) {
  const calls = [];
  async function fakeFetch(url, init) {
    calls.push({ url, init });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (route && route.__status) return { ok: false, status: route.__status, json: async () => ({}) };
    if (route && route.__notJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } };
    return { ok: true, status: 200, json: async () => clone(route) };
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

function createMemoryStore(initial) {
  let record = initial === undefined ? null : clone(initial);
  const store = {
    puts: 0,
    failGet: false,
    failPut: false,
    async get() {
      if (store.failGet) throw new Error("get failed");
      return record === null ? null : clone(record);
    },
    async put(next) {
      if (store.failPut) throw new Error("put failed");
      store.puts += 1;
      record = clone(next);
    },
    peek() {
      return record;
    },
  };
  return store;
}

function liveRoutes() {
  return { [manifestUrl()]: liveManifest, [snapshotUrl(REV1)]: liveSnapshot };
}

function buildService(routes, store) {
  const fetch = createFakeFetch(routes);
  const readPort = createCatalogReadPort({ fetch });
  return { service: createCatalogService({ readPort, store, now: () => 1234 }), fetch };
}

// --- Read Port ---

test("RP1. requests go to the Firebase Storage download URL for the contract paths", async () => {
  const fetch = createFakeFetch(liveRoutes());
  const port = createCatalogReadPort({ fetch });
  const manifest = await port.fetchManifest();
  await port.fetchVerifiedSnapshot(manifest);
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    "https://firebasestorage.googleapis.com/v0/b/auls-kitchen.firebasestorage.app/o/catalog%2Fmanifest.json?alt=media",
    "https://firebasestorage.googleapis.com/v0/b/auls-kitchen.firebasestorage.app/o/catalog%2F" + REV1 + ".json?alt=media",
  ]);
  assert.equal(fetch.calls[0].init.cache, "no-store");
  assert.equal(fetch.calls[0].init.method, "GET");
});

test("RP2. read-port failure codes", async () => {
  const cases = [
    [{ [manifestUrl()]: new TypeError("offline") }, "fetchManifest", "MANIFEST_UNAVAILABLE"],
    [{ [manifestUrl()]: { __status: 503 } }, "fetchManifest", "MANIFEST_UNAVAILABLE"],
    [{ [manifestUrl()]: { __notJson: true } }, "fetchManifest", "MANIFEST_MALFORMED"],
    [{ [manifestUrl()]: { revision: "x" } }, "fetchManifest", "MANIFEST_MALFORMED"],
  ];
  for (const [routes, method, code] of cases) {
    const port = createCatalogReadPort({ fetch: createFakeFetch(routes) });
    await assert.rejects(port[method](), (error) => error.code === code);
  }
  const port = createCatalogReadPort({ fetch: createFakeFetch({ [snapshotUrl(REV1)]: { __status: 404 } }) });
  await assert.rejects(port.fetchVerifiedSnapshot(clone(liveManifest)), (error) => error.code === "SNAPSHOT_UNAVAILABLE");
});

// --- D. valid catalog acceptance ---

test("D2. cold start: fetch, verify, persist and return the live V1 catalog (36 products)", async () => {
  const store = createMemoryStore();
  const { service } = buildService(liveRoutes(), store);
  const result = await service.loadCatalog();
  assert.equal(result.status, CATALOG_STATUS.CURRENT);
  assert.equal(result.source, "network");
  assert.equal(result.persisted, true);
  assert.equal(result.catalog.revision, REV1);
  assert.equal(result.catalog.products.length, 36);
  assert.equal(store.peek().revision, REV1);
  assert.equal(store.peek().products.length, 36);
  assert.equal(store.peek().verifiedAt, 1234);
  assert.equal(store.peek().schemaVersion, 1);
});

// --- E. invalid revision rejection ---

test("E1. snapshot revision differing from the manifest is rejected and never persisted", async () => {
  const wrong = clone(liveSnapshot);
  wrong.revision = "e".repeat(64);
  const store = createMemoryStore();
  const { service } = buildService({ [manifestUrl()]: liveManifest, [snapshotUrl(REV1)]: wrong }, store);
  const result = await service.loadCatalog();
  assert.deepEqual(result, { status: CATALOG_STATUS.UNAVAILABLE, reason: "SNAPSHOT_REVISION_MISMATCH" });
  assert.equal(store.puts, 0);
});

// --- F. invalid SHA rejection ---

test("F3. tampered snapshot content (integrity mismatch) is rejected and never persisted", async () => {
  const tampered = clone(liveSnapshot);
  tampered.products[0].price = 1;
  const store = createMemoryStore();
  const { service } = buildService({ [manifestUrl()]: liveManifest, [snapshotUrl(REV1)]: tampered }, store);
  const result = await service.loadCatalog();
  assert.deepEqual(result, { status: CATALOG_STATUS.UNAVAILABLE, reason: "INTEGRITY_MISMATCH" });
  assert.equal(store.puts, 0);
});

// --- I. matching revision uses cache ---

test("I1. matching revision serves the verified local catalog without downloading the snapshot", async () => {
  const store = createMemoryStore();
  await buildService(liveRoutes(), store).service.loadCatalog();
  const { service, fetch } = buildService(liveRoutes(), store);
  const result = await service.loadCatalog();
  assert.equal(result.status, CATALOG_STATUS.CURRENT);
  assert.equal(result.source, "cache");
  assert.equal(result.catalog.products.length, 36);
  assert.deepEqual(fetch.calls.map((c) => c.url), [manifestUrl()]);
  assert.equal(store.puts, 1);
});

test("I2. a corrupted local record is not trusted: the snapshot is re-fetched and re-verified", async () => {
  const store = createMemoryStore({ schemaVersion: 1, revision: REV1, products: clone(liveSnapshot.products).slice(1), verifiedAt: 1 });
  const { service, fetch } = buildService(liveRoutes(), store);
  const result = await service.loadCatalog();
  assert.equal(result.source, "network");
  assert.equal(fetch.calls.length, 2);
  assert.equal(store.peek().products.length, 36);
});

// --- J. revision change ---

test("J1. a new manifest revision fetches, verifies and replaces the stored catalog", async () => {
  const store = createMemoryStore();
  await buildService(liveRoutes(), store).service.loadCatalog();
  const rev2 = buildRevision2();
  const { service } = buildService({ [manifestUrl()]: rev2.manifest, [snapshotUrl(rev2.manifest.revision)]: rev2.snapshot }, store);
  const result = await service.loadCatalog();
  assert.equal(result.status, CATALOG_STATUS.CURRENT);
  assert.equal(result.source, "network");
  assert.equal(result.catalog.revision, rev2.manifest.revision);
  assert.equal(store.peek().revision, rev2.manifest.revision);
});

// --- K. failed refresh preserves previous valid catalog ---

test("K1. every refresh failure keeps the previous verified catalog (STALE) and never overwrites it", async () => {
  const rev2 = buildRevision2();
  const badRev2 = clone(rev2.snapshot);
  badRev2.products[0].price = 1;
  const failures = [
    [{ [manifestUrl()]: new TypeError("offline") }, "MANIFEST_UNAVAILABLE"],
    [{ [manifestUrl()]: { __status: 500 } }, "MANIFEST_UNAVAILABLE"],
    [{ [manifestUrl()]: { revision: "bad" } }, "MANIFEST_MALFORMED"],
    [{ [manifestUrl()]: rev2.manifest }, "SNAPSHOT_UNAVAILABLE"],
    [{ [manifestUrl()]: rev2.manifest, [snapshotUrl(rev2.manifest.revision)]: { __notJson: true } }, "SNAPSHOT_MALFORMED"],
    [{ [manifestUrl()]: rev2.manifest, [snapshotUrl(rev2.manifest.revision)]: badRev2 }, "INTEGRITY_MISMATCH"],
  ];
  for (const [routes, reason] of failures) {
    const store = createMemoryStore();
    await buildService(liveRoutes(), store).service.loadCatalog();
    const before = clone(store.peek());
    const result = await buildService(routes, store).service.loadCatalog();
    assert.equal(result.status, CATALOG_STATUS.STALE, reason);
    assert.equal(result.reason, reason);
    assert.equal(result.catalog.revision, REV1);
    assert.deepEqual(store.peek(), before);
    assert.equal(store.puts, 1);
  }
});

test("K2. with no verified local catalog, a failure is UNAVAILABLE (never unverified data)", async () => {
  const { service } = buildService({ [manifestUrl()]: new TypeError("offline") }, createMemoryStore());
  assert.deepEqual(await service.loadCatalog(), { status: CATALOG_STATUS.UNAVAILABLE, reason: "MANIFEST_UNAVAILABLE" });
});

test("K3. IndexedDB write failure: verified catalog still returned, persisted=false, old record intact", async () => {
  const store = createMemoryStore();
  store.failPut = true;
  const { service } = buildService(liveRoutes(), store);
  const result = await service.loadCatalog();
  assert.equal(result.status, CATALOG_STATUS.CURRENT);
  assert.equal(result.persisted, false);
  assert.equal(store.peek(), null);
});

test("K4. IndexedDB read failure while offline is reported, not thrown", async () => {
  const store = createMemoryStore();
  store.failGet = true;
  const { service } = buildService({ [manifestUrl()]: new TypeError("offline") }, store);
  assert.deepEqual(await service.loadCatalog(), { status: CATALOG_STATUS.UNAVAILABLE, reason: "CATALOG_STORE_ERROR+MANIFEST_UNAVAILABLE" });
});

test("K5. concurrent loadCatalog() calls share one load (no duplicate downloads)", async () => {
  const store = createMemoryStore();
  const { service, fetch } = buildService(liveRoutes(), store);
  const [a, b] = await Promise.all([service.loadCatalog(), service.loadCatalog()]);
  assert.equal(a, b);
  assert.equal(fetch.calls.length, 2);
  assert.equal(store.puts, 1);
});

test("K6. construction requires readPort and store", () => {
  assert.throws(() => createCatalogService({}), TypeError);
  assert.throws(() => createCatalogService({ readPort: { fetchManifest() {}, fetchVerifiedSnapshot() {} } }), TypeError);
  assert.throws(() => createCatalogReadPort({}), TypeError);
});
