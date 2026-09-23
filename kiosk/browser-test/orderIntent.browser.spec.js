"use strict";

/**
 * STEP89 - Real Firebase Functions Emulator verification of the
 * `orderIntent` Cloud Function, driven through the real, unmodified
 * kiosk/orderIntent/orderIntentAdapter.js. This is the seam STEP88 kept
 * CONTROLLED (a stub httpsCallable, never invoked) - here it is REAL.
 *
 * PRECONDITIONS (must already be running before this spec is executed):
 *   firebase emulators:start --only auth,functions,firestore --project demo-orderintent-test
 *   npm run build:orderintent-test   (from kiosk/, produces dist/orderIntentAdapter.js)
 *
 * Firestore Emulator status (Guru-review finding, observed empirically,
 * not assumed): REQUIRED (the real orderIntent.js repositories/reservation
 * transaction genuinely read/write Firestore) - rules file NOT REQUIRED
 * (the emulator defaults to allow-all when none is configured in
 * firebase.json, and the Admin SDK bypasses Security Rules regardless of
 * their content either way). No firestore.rules file exists in this repo
 * and none was added for this step.
 */

const { test, expect } = require("@playwright/test");

// Must be set before requiring the seed module, so its firebase-admin
// initialization is guaranteed to target the emulator, never production.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const {
  OK_PRODUCT_ID,
  OK_INGREDIENT_ID,
  SHORTAGE_PRODUCT_ID,
  SHORTAGE_INGREDIENT_ID,
  RECIPE_QTY_PER_UNIT,
  OK_INGREDIENT_STARTING_STOCK,
  SHORTAGE_INGREDIENT_STARTING_STOCK,
  seedFixtures,
  readIngredientStock,
} = require("./seedOrderIntentFixtures");

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "www.gstatic.com"]);

const FORBIDDEN_HOST_PATTERNS = [
  /cloudfunctions\.net$/i,
  /\.googleapis\.com$/i,
  /midtrans/i,
  /qris/i,
];

test.describe("STEP 89 - Real Functions Emulator OrderIntent verification", () => {
  test.beforeAll(async () => {
    await seedFixtures();
  });

  test("D1. real Functions Emulator success path decrements real Firestore stock", async ({ page }) => {
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto("/browser-test/orderIntentHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const state = await page.evaluate(() => ({
      emulatorConnected: window.__step89?.testState?.emulatorConnected,
      functionsEmulatorConnected: window.__step89?.testState?.functionsEmulatorConnected,
      projectId: window.__step89?.testState?.projectId,
    }));
    expect(state.emulatorConnected).toBe(true);
    expect(state.functionsEmulatorConnected).toBe(true);
    expect(state.projectId).toBe("demo-orderintent-test");

    const stockBefore = await readIngredientStock(OK_INGREDIENT_ID);

    const result = await page.evaluate(
      async (productId) => {
        await window.__step89.signIn();
        return window.__step89.submitNew({ productId, quantity: 1 });
      },
      OK_PRODUCT_ID
    );

    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.authoritativeResult).not.toBeNull();
    expect(result.authoritativeResult.orderState).toBe("VALIDATED");

    const stockAfter = await readIngredientStock(OK_INGREDIENT_ID);
    expect(stockAfter).toBe(stockBefore - RECIPE_QTY_PER_UNIT);

    // Network boundary: only localhost/emulators and the approved CDN.
    for (const url of requests) {
      const parsed = new URL(url);
      expect(ALLOWED_HOSTS.has(parsed.hostname)).toBe(true);
      for (const pattern of FORBIDDEN_HOST_PATTERNS) {
        expect(url).not.toMatch(pattern);
      }
    }
    expect(requests.some((url) => url.startsWith("http://127.0.0.1:5001/"))).toBe(true);
    expect(requests.some((url) => url.startsWith("http://127.0.0.1:9099/"))).toBe(true);
  });

  test("D2. idempotency replay against the real transaction does not double-decrement", async ({ page }) => {
    await page.goto("/browser-test/orderIntentHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const fixedKey = "step89-replay-" + Date.now().toString(36);

    const stockBefore = await readIngredientStock(OK_INGREDIENT_ID);

    const results = await page.evaluate(
      async ({ productId, key }) => {
        await window.__step89.signIn();
        const first = await window.__step89.submitNew({ productId, quantity: 1 }, key);
        const second = await window.__step89.submitNew({ productId, quantity: 1 }, key);
        return { first, second };
      },
      { productId: OK_PRODUCT_ID, key: fixedKey }
    );

    expect(results.first.outcome).toBe("SUCCEEDED");
    expect(results.second.outcome).toBe("SUCCEEDED");
    expect(results.first.idempotencyKey).toBe(fixedKey);
    expect(results.second.idempotencyKey).toBe(fixedKey);
    expect(results.second.authoritativeResult).toEqual(results.first.authoritativeResult);

    const stockAfter = await readIngredientStock(OK_INGREDIENT_ID);
    expect(stockAfter).toBe(stockBefore - RECIPE_QTY_PER_UNIT);
  });

  test("D3. real insufficient-stock rejection performs zero writes; STEP90 confirms the corrected REJECTED classification (all-or-nothing)", async ({ page }) => {
    await page.goto("/browser-test/orderIntentHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const stockBefore = await readIngredientStock(SHORTAGE_INGREDIENT_ID);
    expect(stockBefore).toBe(SHORTAGE_INGREDIENT_STARTING_STOCK);

    const result = await page.evaluate(async (productId) => {
      await window.__step89.signIn();
      const r = await window.__step89.submitNew({ productId, quantity: 1 });
      r.__rawError = window.__step89.testState.lastRawError;
      return r;
    }, SHORTAGE_PRODUCT_ID);

    // STEP89 discovered that the real Firebase Functions client SDK
    // returns err.code prefixed as "functions/failed-precondition", which
    // kiosk/orderIntent/orderIntentTypes.js's classifyCallableError did
    // not match (bare-code-only allowlist), falling through to UNKNOWN.
    // STEP90 fixed this with a normalization step in classifyCallableError
    // (strips a leading "functions/" before the existing comparisons).
    // This now confirms the corrected, originally-intended behavior
    // against the REAL Functions Emulator.
    expect(result.__rawError.code).toBe("functions/failed-precondition");
    expect(result.__rawError.details).toEqual({ code: "INSUFFICIENT_STOCK" });
    expect(result.outcome).toBe("REJECTED");
    expect(result.category).toBe("VALIDATION_REJECTION");
    expect(result.reason).toBe("INSUFFICIENT_STOCK");

    // Regardless of classification, the real transaction itself remains
    // correctly all-or-nothing: an aborted Firestore transaction performs
    // zero writes.
    const stockAfter = await readIngredientStock(SHORTAGE_INGREDIENT_ID);
    expect(stockAfter).toBe(stockBefore);
  });

  test("D4. unauthenticated call against the real emulator is rejected by authGuard; STEP90 confirms the corrected REJECTED classification", async ({ page }) => {
    await page.goto("/browser-test/orderIntentHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    // Deliberately never calls signIn() - no ID token is attached.
    const result = await page.evaluate(async (productId) => {
      const r = await window.__step89.submitNew({ productId, quantity: 1 });
      r.__rawError = window.__step89.testState.lastRawError;
      return r;
    }, OK_PRODUCT_ID);

    // Same STEP89->STEP90 fix as D3: authGuard.js genuinely rejects the
    // unauthenticated call (proven by the raw "functions/unauthenticated"
    // code below), and the normalized classifier now correctly reports
    // REJECTED/AUTH_REJECTION instead of the pre-fix UNKNOWN.
    expect(result.__rawError.code).toBe("functions/unauthenticated");
    expect(result.outcome).toBe("REJECTED");
    expect(result.category).toBe("AUTH_REJECTION");
    expect(result.reason).toBe("AUTH_REQUIRED");
  });

  test("D5. production guard - harness and built artifact never reference the real project id", async ({ page }) => {
    await page.goto("/browser-test/orderIntentHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(async () => {
      const html = document.documentElement.outerHTML;
      const response = await fetch("/dist/orderIntentAdapter.js");
      const source = await response.text();
      return {
        htmlContainsRealProject: /auls-kitchen/i.test(html),
        sourceContainsRealProject: /auls-kitchen/i.test(source),
        sourceHasFirebaseSdkImport: /firebase-app|firebase-auth|firebase-functions|gstatic/i.test(source),
      };
    });

    expect(result.htmlContainsRealProject).toBe(false);
    expect(result.sourceContainsRealProject).toBe(false);
    expect(result.sourceHasFirebaseSdkImport).toBe(false);
  });
});
