"use strict";

/**
 * Real Browser Composition Verification (STEP 88).
 *
 * Run with: npm run test:browser (from kiosk/) - i.e. `playwright test`,
 * reusing kiosk/playwright.config.js and kiosk/browser-test/staticServer.js
 * unchanged from STEP 83/85/87. Requires the Firebase Auth Emulator
 * running at 127.0.0.1:9099 (`firebase emulators:start --only auth`) and
 * kiosk/dist/createBrowserKiosk.js + kiosk/dist/indexedDbAdapter.js +
 * kiosk/dist/persistenceAdapter.js already built (`npm run build`,
 * `npm run build:persistence-test`).
 *
 * This file drives compositionHarness.html in a REAL Chromium browser.
 * It proves the REAL createBrowserKiosk() artifact constructs against a
 * REAL Firebase SDK + REAL Firebase Auth Emulator + REAL native
 * IndexedDB, and that host.beginCustomerSession() reaches READY only
 * after the REAL Auth Adapter resolves a REAL Emulator UID and the REAL
 * Runtime hydrates against REAL IndexedDB - never touching production
 * Firebase/Functions/Firestore/OrderIntent/Midtrans/QRIS. The
 * httpsCallable/OrderIntent seam is deliberately CONTROLLED (never a
 * real network request) - see compositionHarness.html's own header
 * comment. Claim boundary: this proves browser composition/bootstrap,
 * NOT Firebase Functions or OrderIntent backend execution.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const HARNESS_PATH = "/browser-test/compositionHarness.html";
const DIST_PATH = path.join(__dirname, "..", "dist", "createBrowserKiosk.js");

const TEST_DB = Object.freeze({
  dbName: "kioskCompositionBrowserTest",
  storeName: "kioskCompositionTest",
  dbVersion: 1,
});

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "www.gstatic.com"]);

const FORBIDDEN_HOST_PATTERNS = [
  /firestore/i,
  /googleapis\.com/i,
  /cloudfunctions/i,
  /midtrans/i,
  /qris/i,
];

function validCartDraft() {
  return {
    lines: [
      {
        localLineId: "line_1",
        productId: "p1",
        quantity: 1,
        selectedModifiers: [],
        displaySnapshot: { name: "Kopi", price: 15000 },
      },
    ],
    customerName: "Step88",
    notes: null,
  };
}

async function resetDatabase(page) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__step88Loaded === true);
  const result = await page.evaluate((name) => window.__step88.deleteDatabase(name), TEST_DB.dbName);
  expect(result.ok).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await resetDatabase(page);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await resetDatabase(page);
  await page.close();
});

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

test("C1-C4. real Firebase SDK loads, synthetic config is used, Auth Emulator connects before any Auth operation", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto(HARNESS_PATH);
  await expect(page.locator("#status")).toHaveText("READY");

  const state = await page.evaluate(() => ({
    emulatorConnected: window.__step88.testState.emulatorConnected,
    emulatorUrl: window.__step88.testState.emulatorUrl,
    projectId: window.__step88.testState.projectId,
    signInCalls: window.__step88.testState.signInCalls,
  }));

  expect(state.emulatorConnected).toBe(true);
  expect(state.emulatorUrl).toBe("http://127.0.0.1:9099");
  expect(state.projectId).toBe("demo-no-project");
  // C4: the emulator connection above happened during page load, before
  // any Auth operation - no sign-in has occurred yet.
  expect(state.signInCalls).toBe(0);

  for (const url of requests) {
    const parsed = new URL(url);
    expect(ALLOWED_HOSTS.has(parsed.hostname)).toBe(true);
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      expect(parsed.hostname).not.toMatch(pattern);
    }
  }
  expect(
    requests.some((url) => url.startsWith("https://www.gstatic.com/firebasejs/10.12.2/"))
  ).toBe(true);
});

test("C5-C9. the actual generated createBrowserKiosk artifact loads and constructs the real Host, with no automatic session or Auth", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await expect(page.locator("#status")).toHaveText("READY");

  const result = await page.evaluate((db) => window.__step88.construct(db), TEST_DB);

  // C6/C8: the real, unmodified Host surface - exactly these three keys.
  expect(result.hostKeys).toEqual(["beginCustomerSession", "getBootstrapStatus", "orchestrator"]);
  // C9: construction alone never starts a session or hydrates.
  expect(result.bootstrapStatus).toBe("BOOTSTRAPPING");
  expect(result.snapshotReady).toBe(false);

  const afterConstruct = await page.evaluate(() => ({
    signInCalls: window.__step88.testState.signInCalls,
    signOutCalls: window.__step88.testState.signOutCalls,
  }));
  expect(afterConstruct.signInCalls).toBe(0);
  expect(afterConstruct.signOutCalls).toBe(0);
});

test("C10-C14. beginCustomerSession resolves a real Auth Emulator UID and Runtime hydrates against real IndexedDB", async ({ page }) => {
  await page.goto(HARNESS_PATH);
  await expect(page.locator("#status")).toHaveText("READY");

  await page.evaluate((db) => window.__step88.construct(db), TEST_DB);

  // First bootstrap: fresh/empty real IndexedDB database.
  const first = await page.evaluate(() => window.__step88.beginCustomerSession());
  expect(first.result.status).toBe("READY");
  // C13: Host only reports READY because actual Runtime hydrate() succeeded.
  expect(first.bootstrapStatus).toBe("READY");
  expect(first.snapshot.ready).toBe(true);
  // C11/C12: a real Auth Emulator UID, and it is a plain string - never a
  // Firebase User object (only a primitive crosses this boundary at all).
  expect(first.resolvedUidType).toBe("string");
  expect(first.resolvedUid.length).toBeGreaterThan(0);
  expect(first.snapshot.cart.lines).toEqual([]); // EMPTY hydration on a fresh DB

  // Seed a Cart Draft directly into the SAME real IndexedDB test database,
  // independently of Host/Runtime, keyed to the just-resolved real uid.
  const seed = await page.evaluate(
    ({ db, uid, cart }) => window.__step88.seedCartDraft(db, uid, cart),
    { db: TEST_DB, uid: first.resolvedUid, cart: validCartDraft() }
  );
  expect(seed.ok).toBe(true);

  // Re-run the SAME Host's real bootstrap lifecycle for "the next session".
  const second = await page.evaluate(() => window.__step88.beginCustomerSession());
  expect(second.bootstrapStatus).toBe("READY");
  // Identity is cached by the real Auth Adapter - no re-sign-in occurred.
  expect(second.resolvedUid).toBe(first.resolvedUid);
  // C14: the real Runtime/persistence path actually read back what was
  // really written to real IndexedDB - not merely "did not throw".
  expect(second.snapshot.cart.lines.length).toBe(1);
  expect(second.snapshot.cart.lines[0].productId).toBe("p1");
  expect(second.snapshot.cart.customerName).toBe("Step88");

  const signInCalls = await page.evaluate(() => window.__step88.testState.signInCalls);
  expect(signInCalls).toBe(1);
});

test("C15-C17. no production/business-effect network occurs; the controlled httpsCallable seam is constructed but never invoked", async ({ page }) => {
  const externalRequests = [];
  page.on("request", (request) => {
    const parsed = new URL(request.url());
    if (!ALLOWED_HOSTS.has(parsed.hostname)) externalRequests.push(request.url());
  });

  await page.goto(HARNESS_PATH);
  await expect(page.locator("#status")).toHaveText("READY");
  await page.evaluate((db) => window.__step88.construct(db), TEST_DB);
  await page.evaluate(() => window.__step88.beginCustomerSession());

  // C15/C17: zero requests to any non-allowlisted origin (no Firestore,
  // no production Functions/cloudfunctions, no Midtrans/QRIS).
  expect(externalRequests).toEqual([]);

  const callable = await page.evaluate(() => ({
    getFunctionsCalls: window.__step88.testState.getFunctionsCalls,
    httpsCallableCalls: window.__step88.testState.httpsCallableCalls,
    httpsCallableInvocations: window.__step88.testState.httpsCallableInvocations,
  }));
  // C16: the seam exists (constructed once by the real createBrowserKiosk
  // composition) but is never actually invoked - OrderIntent/Functions
  // backend execution is intentionally outside this step's scope.
  expect(callable.getFunctionsCalls).toBe(1);
  expect(callable.httpsCallableCalls).toBe(1);
  expect(callable.httpsCallableInvocations).toBe(0);
});

test("C18-C19. the generated artifact bundles no Firebase SDK and no forbidden production dependency", () => {
  const source = fs.readFileSync(DIST_PATH, "utf8");
  const lowerSource = source.toLowerCase();
  const forbidden = [
    "gstatic", "firebasejs", "firebase-app", "firebase-auth", "firebase-functions",
    "firebase-admin", "firestore", "midtrans", "qris",
    "aul-world-runtime", "pixi", "playwright", "vitest", "node:test",
  ];
  for (const term of forbidden) {
    expect(lowerSource.includes(term.toLowerCase())).toBe(false);
  }
  expect(source.includes('require("fs")')).toBe(false);
  expect(source.includes('require("path")')).toBe(false);
});

test("production guard: the harness never references the real .firebaserc project id", () => {
  const harnessSource = fs.readFileSync(path.join(__dirname, "compositionHarness.html"), "utf8");
  expect(harnessSource.includes("auls-kitchen")).toBe(false);
});

test("C20. cleanup of the STEP 88 test database succeeds", async ({ page }) => {
  await resetDatabase(page);
});
