"use strict";

/**
 * Kiosk browser artifact verification (STEP 83).
 *
 * Run with: npm run test:browser (from kiosk/) - i.e. `playwright test`,
 * using kiosk/playwright.config.js. Requires kiosk/dist/createBrowserKiosk.js
 * to already exist (run `npm run build` first - see package.json comments/
 * STEP 83 report for the required sequence).
 *
 * This file drives kioskHarness.html in a REAL Chromium browser via
 * Playwright. It proves artifact loading + browser execution +
 * createBrowserKiosk() construction against deterministic fakes only.
 * It never calls beginCustomerSession(), never touches real IndexedDB,
 * never touches real Firebase, and never makes a non-localhost network
 * request - see kioskHarness.html's own header comment for the exact
 * fake Firebase shape used.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const HARNESS_PATH = "/browser-test/kioskHarness.html";
const DIST_PATH = path.join(__dirname, "..", "dist", "createBrowserKiosk.js");

test.beforeEach(async ({ page }) => {
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(error));
  page.on("console", (msg) => {
    if (msg.type() === "error") page.__errors.push(new Error(msg.text()));
  });
});

test.afterEach(async ({ page }) => {
  expect(page.__errors || []).toEqual([]);
});

test("B1. artifact loads - harness page imports the generated artifact with no page error", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  expect(page.__errors).toEqual([]);
});

test("B2. export shape - createBrowserKiosk is a function; documented default-export interop shape confirmed", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const info = await page.evaluate(() => ({
    exportShape: window.__kioskTest.exportShape,
    isFunction: window.__kioskTest.createBrowserKioskIsFunction,
  }));
  expect(info.isFunction).toBe(true);
  expect(info.exportShape).toEqual(["DEFAULT_FUNCTIONS_REGION", "createBrowserKiosk"]);
});

test("B3. factory construction - createBrowserKiosk(...) returns without throwing given fake Firebase deps", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct());
  expect(result.ok).toBe(true);
});

test("B4. Host surface - returned object has exactly beginCustomerSession/getBootstrapStatus/orchestrator, no ownerUid", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct());
  expect(result.hostKeys).toEqual(["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
  expect(result.snapshotHasOwnerUid).toBe(false);
});

test("B5. no automatic hydration - bootstrapStatus is BOOTSTRAPPING and snapshot.ready is false immediately after construction", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct());
  expect(result.bootstrapStatus).toBe("BOOTSTRAPPING");
  expect(result.snapshotReady).toBe(false);
});

test("B6. no automatic Auth - signInAnonymously/signOut call counts are 0 immediately after construction", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct());
  expect(result.signInAnonymouslyCallCount).toBe(0);
  expect(result.signOutCallCount).toBe(0);
});

test("B7. Firebase composition calls - initializeApp/getAuth/getFunctions/httpsCallable each exactly once, correctly wired", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct());
  expect(result.initializeAppCallCount).toBe(1);
  expect(result.getAuthCallCount).toBe(1);
  expect(result.getFunctionsCallCount).toBe(1);
  expect(result.httpsCallableCallCount).toBe(1);
  expect(result.authReceivedSameApp).toBe(true);
  expect(result.functionsReceivedSameApp).toBe(true);
  expect(result.functionsRegion).toBe("us-central1");
  expect(result.callableReceivedValidFunctionsInstance).toBe(true);
  expect(result.callableName).toBe("orderIntent");
});

test("B8. no production network - zero requests to any non-localhost origin", async ({ page }) => {
  const externalRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      externalRequests.push(request.url());
    }
  });
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  await page.evaluate(() => window.__kioskTest.construct());
  expect(externalRequests).toEqual([]);
});

test("B9. forbidden dependency scan - the generated artifact contains no forbidden runtime dependency", () => {
  const source = fs.readFileSync(DIST_PATH, "utf8");
  const forbidden = [
    "firebase-admin", "firebase-functions", "firestore", "midtrans", "qris",
    "aul-world-runtime", "pixi", "playwright", "vitest", "node:test",
    "gstatic", "firebasejs",
  ];
  const lowerSource = source.toLowerCase();
  for (const term of forbidden) {
    expect(lowerSource.includes(term.toLowerCase())).toBe(false);
  }
  expect(source.includes('require("fs")')).toBe(false);
  expect(source.includes('require("path")')).toBe(false);
  // Documented false positive, not a violation: the existing LOCKED
  // Session Machine's own paymentOutcomeAmbiguous future-extension
  // field legitimately contains the word "payment".
  expect(source.includes("paymentOutcomeAmbiguous")).toBe(true);
});

test("B10. repeated construction - two independent constructions in the same page produce identical structural results", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const first = await page.evaluate(() => window.__kioskTest.construct());
  const second = await page.evaluate(() => window.__kioskTest.construct());
  expect(second).toEqual(first);
});

test("B11. negative control - an incomplete Firebase fake causes createBrowserKiosk to reject with the expected validation error", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__kioskModuleLoaded === true);
  const result = await page.evaluate(() => window.__kioskTest.construct({ signOut: undefined }));
  expect(result.ok).toBe(false);
  expect(result.error.name).toBe("TypeError");
  expect(result.error.message.includes("signOut")).toBe(true);
});
