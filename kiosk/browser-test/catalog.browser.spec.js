"use strict";

/**
 * Kiosk Catalog Consumer Foundation - real browser verification.
 *
 * Run with (from kiosk/): npm run build:catalog-test && npx playwright test catalog.browser.spec.js
 *
 * Proves, in real Chromium with REAL IndexedDB and REAL WebCrypto:
 *   G  the dedicated kioskCatalog object store (put/get, fixed key)
 *   H  the additive v1 -> v2 migration preserves kioskPersistence data
 *   L  customer-context resets never touch the catalog store
 *   I  reload recovers the verified catalog from IndexedDB (no snapshot download)
 *   K  a failed refresh (offline) keeps serving the verified catalog as STALE
 *   LIVE  the actual published Catalog V1 (live Firebase Storage) is read,
 *         verified (36 products, expected revision), persisted and recovered
 *
 * Network: the harness origin is http://127.0.0.1, which the bucket's CORS
 * policy (kiosk.aulia.fun only) does not allow. Requests to
 * firebasestorage.googleapis.com are therefore answered through
 * page.route(): from the committed fixtures (deterministic tests) or, for
 * LIVE, with the real response fetched from Firebase Storage via
 * route.fetch() and passed through unmodified apart from an
 * Access-Control-Allow-Origin header. Only GET requests are ever made.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const HARNESS_PATH = "/browser-test/catalogHarness.html";
const DIST_ENTRY = path.join(__dirname, "..", "dist", "catalog-test", "catalog", "createBrowserCatalog.js");
const FIXTURES = path.join(__dirname, "..", "catalog", "fixtures");
const MANIFEST_BODY = fs.readFileSync(path.join(FIXTURES, "catalogV1Manifest.json"));
const SNAPSHOT_BODY = fs.readFileSync(path.join(FIXTURES, "catalogV1Snapshot.json"));
const LIVE_REVISION = "1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f";
const STORAGE_PATTERN = "https://firebasestorage.googleapis.com/**";
const MANIFEST_OBJECT = "catalog%2Fmanifest.json";
const SNAPSHOT_OBJECT = "catalog%2F" + LIVE_REVISION + ".json";

const DB_STORE = "kioskCatalogBrowserTest_store";
const DB_MIGRATION = "kioskCatalogBrowserTest_migration";
const DB_FLOW = "kioskCatalogBrowserTest_flow";
const DB_LIVE = "kioskCatalogBrowserTest_live";

function corsJson(body) {
  return { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body };
}

/** Serves the fixtures; `mode.offline` aborts every Storage request. Records requested objects. */
async function routeFixtures(page, mode) {
  const requested = [];
  await page.route(STORAGE_PATTERN, async (route) => {
    const url = route.request().url();
    requested.push(url.includes(MANIFEST_OBJECT) ? "manifest" : url.includes(SNAPSHOT_OBJECT) ? "snapshot" : url);
    if (mode.offline) return route.abort("internetdisconnected");
    if (url.includes(MANIFEST_OBJECT)) return route.fulfill(corsJson(MANIFEST_BODY));
    if (url.includes(SNAPSHOT_OBJECT)) return route.fulfill(corsJson(SNAPSHOT_BODY));
    return route.fulfill({ status: 404, body: "" });
  });
  return requested;
}

async function openHarness(page) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__catalogTestLoaded === true);
}

async function freshDb(page, name) {
  await openHarness(page); // fresh navigation drops every open connection first
  await page.evaluate((n) => window.__catalogTest.deleteDatabase(n), name);
  await openHarness(page);
}

test.beforeAll(() => {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error("Missing " + DIST_ENTRY + " - run `npm run build:catalog-test` first.");
  }
});

test("G. dedicated catalog store: real IndexedDB put/get under one fixed key, database at v2 with both stores", async ({ page }) => {
  await freshDb(page, DB_STORE);
  expect(await page.evaluate(() => window.__catalogTest.hasPrereqs())).toBe(true);
  expect(await page.evaluate((n) => window.__catalogTest.readCatalogRecord(n), DB_STORE)).toBeNull();

  const products = JSON.parse(SNAPSHOT_BODY.toString("utf8")).products;
  await page.evaluate(({ n, r }) => window.__catalogTest.putCatalogRecord(n, r), {
    n: DB_STORE,
    r: { schemaVersion: 1, revision: LIVE_REVISION, products, verifiedAt: 42 },
  });
  await openHarness(page); // reload: prove durability across page loads
  expect(await page.evaluate((n) => window.__catalogTest.readCatalogRecord(n), DB_STORE)).toEqual({
    schemaVersion: 1, revision: LIVE_REVISION, productCount: 36, verifiedAt: 42,
  });
  expect(await page.evaluate((n) => window.__catalogTest.describeDb(n), DB_STORE)).toEqual({
    version: 2, stores: ["kioskCatalog", "kioskPersistence"],
  });
});

test("H + L. v1 -> v2 migration preserves kioskPersistence; customer-context reset never touches the catalog", async ({ page }) => {
  await routeFixtures(page, {});
  await freshDb(page, DB_MIGRATION);

  const legacyRecord = { schemaVersion: 1, ownerUidAtWrite: "legacyOwnerUid", writtenAt: 1700000000000, cartDraft: null, submissionAttempt: null, authoritativeResult: null };
  await page.evaluate(({ n, r }) => window.__catalogTest.createLegacyV1(n, r), { n: DB_MIGRATION, r: legacyRecord });
  expect(await page.evaluate((n) => window.__catalogTest.describeDb(n), DB_MIGRATION)).toEqual({ version: 1, stores: ["kioskPersistence"] });

  await openHarness(page);
  // The catalog layer opens first here and performs the v1 -> v2 upgrade.
  const loaded = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_MIGRATION);
  expect(loaded.status).toBe("CURRENT");
  expect(loaded.persisted).toBe(true);
  expect(await page.evaluate((n) => window.__catalogTest.describeDb(n), DB_MIGRATION)).toEqual({ version: 2, stores: ["kioskCatalog", "kioskPersistence"] });
  expect(await page.evaluate((n) => window.__catalogTest.rawPersistenceRecord(n), DB_MIGRATION)).toEqual(legacyRecord);

  // L: the runtime's customer-context reset deletes only its own key.
  await page.evaluate((n) => window.__catalogTest.purgeCustomerContext(n), DB_MIGRATION);
  expect(await page.evaluate((n) => window.__catalogTest.rawPersistenceRecord(n), DB_MIGRATION)).toBeNull();
  const record = await page.evaluate((n) => window.__catalogTest.readCatalogRecord(n), DB_MIGRATION);
  expect(record.revision).toBe(LIVE_REVISION);
  expect(record.productCount).toBe(36);
});

test("I + K. reload serves the verified cache without re-downloading; offline serves it as STALE", async ({ page }) => {
  const requested = await routeFixtures(page, {});
  await freshDb(page, DB_FLOW);

  const first = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_FLOW);
  expect(first).toMatchObject({ status: "CURRENT", source: "network", persisted: true, revision: LIVE_REVISION, productCount: 36 });
  expect(requested).toEqual(["manifest", "snapshot"]);

  requested.length = 0;
  await openHarness(page);
  const second = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_FLOW);
  expect(second).toMatchObject({ status: "CURRENT", source: "cache", revision: LIVE_REVISION, productCount: 36 });
  expect(second.productIds).toEqual(first.productIds);
  expect(requested).toEqual(["manifest"]);

  await page.unroute(STORAGE_PATTERN);
  await routeFixtures(page, { offline: true });
  await openHarness(page);
  const offline = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_FLOW);
  expect(offline).toMatchObject({ status: "STALE", reason: "MANIFEST_UNAVAILABLE", revision: LIVE_REVISION, productCount: 36 });
});

test("LIVE. the real published Catalog V1 is read, verified, persisted and recovered after reload", async ({ browser }) => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  // A hand-made context inherits neither baseURL nor a proxy bypass: the
  // harness itself stays on 127.0.0.1, only Storage goes through the proxy.
  const context = await browser.newContext(
    Object.assign({ baseURL: test.info().project.use.baseURL }, proxy ? { proxy: { server: proxy, bypass: "127.0.0.1,localhost" } } : {})
  );
  const page = await context.newPage();
  const live = [];
  await page.route(STORAGE_PATTERN, async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    const response = await route.fetch(); // real Firebase Storage response
    live.push({ url: route.request().url(), status: response.status(), contentType: response.headers()["content-type"] });
    return route.fulfill({ response, headers: Object.assign({}, response.headers(), { "access-control-allow-origin": "*" }) });
  });

  try {
    await openHarness(page);
    await page.evaluate((n) => window.__catalogTest.deleteDatabase(n), DB_LIVE);
    await openHarness(page);

    const result = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_LIVE);
    console.log("LIVE requests:", JSON.stringify(live));
    console.log("LIVE result:", JSON.stringify({ status: result.status, source: result.source, persisted: result.persisted, revision: result.revision, productCount: result.productCount }));
    expect(live.map((r) => r.status)).toEqual([200, 200]);
    expect(result).toMatchObject({ status: "CURRENT", source: "network", persisted: true, revision: LIVE_REVISION, productCount: 36 });

    live.length = 0;
    await openHarness(page);
    const reloaded = await page.evaluate((n) => window.__catalogTest.loadCatalog(n), DB_LIVE);
    console.log("LIVE after reload:", JSON.stringify({ status: reloaded.status, source: reloaded.source, revision: reloaded.revision, productCount: reloaded.productCount, requests: live.length }));
    expect(reloaded).toMatchObject({ status: "CURRENT", source: "cache", revision: LIVE_REVISION, productCount: 36 });
    expect(reloaded.productIds).toEqual(result.productIds);
    expect(live.length).toBe(1); // manifest only

    await page.evaluate((n) => window.__catalogTest.deleteDatabase(n), DB_LIVE);
  } finally {
    await context.close();
  }
});
