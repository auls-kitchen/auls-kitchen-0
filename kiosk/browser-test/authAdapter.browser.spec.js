"use strict";

const { test, expect } = require("@playwright/test");

const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "www.gstatic.com",
]);

const FORBIDDEN_HOST_PATTERNS = [
  /firestore/i,
  /googleapis\.com/i,
  /cloudfunctions/i,
  /midtrans/i,
  /qris/i,
];

test.describe("STEP 87 - Firebase Auth Emulator browser verification", () => {
  test("A1-A5. real SDK + emulator + adapter initialization", async ({ page }) => {
  const requests = [];

  page.on("request", (request) => {
    requests.push(request.url());
  });

  await page.goto("/browser-test/authHarness.html");

  await expect(page.locator("#status")).toHaveText("READY");

  const state = await page.evaluate(() => ({
    emulatorConnected: window.__step87Auth?.testState?.emulatorConnected,
    emulatorUrl: window.__step87Auth?.testState?.emulatorUrl,
    projectId: window.__step87Auth?.testState?.projectId,
    adapterKeys: Object.keys(window.__step87Auth?.adapter || {}),
    resolveType: typeof window.__step87Auth?.resolveOwnerUid,
    resetType: typeof window.__step87Auth?.requestAuthReset,
  }));

  expect(state.emulatorConnected).toBe(true);
  expect(state.emulatorUrl).toBe("http://127.0.0.1:9099");
  expect(state.projectId).toBe("demo-no-project");

  expect(state.adapterKeys.sort()).toEqual([
    "requestAuthReset",
    "resolveOwnerUid",
  ]);

  expect(state.resolveType).toBe("function");
  expect(state.resetType).toBe("function");

  // Trigger a real Auth Emulator operation through the adapter.
  const uid = await page.evaluate(() =>
    window.__step87Auth.resolveOwnerUid()
  );

  expect(typeof uid).toBe("string");
  expect(uid.length).toBeGreaterThan(0);

  // Network boundary: only localhost and the approved Firebase CDN.
  for (const url of requests) {
    const parsed = new URL(url);

    expect(ALLOWED_HOSTS.has(parsed.hostname)).toBe(true);

    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      expect(parsed.hostname).not.toMatch(pattern);
    }
  }

  expect(
    requests.some((url) =>
      url.startsWith("http://127.0.0.1:9099/")
    )
  ).toBe(true);

  expect(
    requests.some((url) =>
      url.startsWith("https://www.gstatic.com/firebasejs/10.12.2/")
    )
  ).toBe(true);
});

  test("A6-A9. real emulator anonymous UID + stable repeated resolve", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(async () => {
      const first = await window.__step87Auth.resolveOwnerUid();
      const signInsAfterFirst =
        window.__step87Auth.testState.signInCalls;

      const second = await window.__step87Auth.resolveOwnerUid();
      const signInsAfterSecond =
        window.__step87Auth.testState.signInCalls;

      return {
        first,
        second,
        signInsAfterFirst,
        signInsAfterSecond,
        type: typeof first,
      };
    });

    expect(typeof result.first).toBe("string");
    expect(result.first.length).toBeGreaterThan(0);
    expect(result.second).toBe(result.first);
    expect(result.type).toBe("string");
    expect(result.signInsAfterFirst).toBe(1);
    expect(result.signInsAfterSecond).toBe(1);
  });

  test("A10-A12. UID reset rotates identity and subsequent resolve stays on UID-B", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(async () => {
      const uidA = await window.__step87Auth.resolveOwnerUid();

      const signInsBeforeReset =
        window.__step87Auth.testState.signInCalls;
      const signOutsBeforeReset =
        window.__step87Auth.testState.signOutCalls;

      await window.__step87Auth.requestAuthReset();

      const signInsAfterReset =
        window.__step87Auth.testState.signInCalls;
      const signOutsAfterReset =
        window.__step87Auth.testState.signOutCalls;

      const uidB = await window.__step87Auth.resolveOwnerUid();

      const signInsAfterResolve =
        window.__step87Auth.testState.signInCalls;

      const uidBAgain = await window.__step87Auth.resolveOwnerUid();

      return {
        uidA,
        uidB,
        uidBAgain,
        signInsBeforeReset,
        signInsAfterReset,
        signOutsBeforeReset,
        signOutsAfterReset,
        signInsAfterResolve,
      };
    });

    expect(result.uidA).toEqual(expect.any(String));
    expect(result.uidB).toEqual(expect.any(String));
    expect(result.uidA).not.toBe(result.uidB);
    expect(result.uidBAgain).toBe(result.uidB);

    expect(result.signInsBeforeReset).toBe(1);
    expect(result.signInsAfterReset).toBe(2);
    expect(result.signInsAfterResolve).toBe(2);

    expect(result.signOutsBeforeReset).toBe(0);
    expect(result.signOutsAfterReset).toBe(1);
  });

  test("A13-A15. concurrent resolve and reset calls are deduplicated", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(async () => {
      const initial = await window.__step87Auth.resolveOwnerUid();

      const resolveResults = await Promise.all([
        window.__step87Auth.resolveOwnerUid(),
        window.__step87Auth.resolveOwnerUid(),
        window.__step87Auth.resolveOwnerUid(),
      ]);

      const signInsAfterConcurrentResolve =
        window.__step87Auth.testState.signInCalls;

      const resetResults = await Promise.all([
        window.__step87Auth.requestAuthReset(),
        window.__step87Auth.requestAuthReset(),
        window.__step87Auth.requestAuthReset(),
      ]);

      const uidAfterReset =
        await window.__step87Auth.resolveOwnerUid();

      return {
        initial,
        resolveResults,
        resetResults,
        uidAfterReset,
        signIns: window.__step87Auth.testState.signInCalls,
        signOuts: window.__step87Auth.testState.signOutCalls,
        signInsAfterConcurrentResolve,
      };
    });

    expect(result.initial).toEqual(expect.any(String));
    expect(result.resolveResults).toEqual([
      result.initial,
      result.initial,
      result.initial,
    ]);

    expect(result.signInsAfterConcurrentResolve).toBe(1);

    expect(result.resetResults).toEqual([undefined, undefined, undefined]);
    expect(result.signOuts).toBe(1);
    expect(result.signIns).toBe(2);

    expect(result.uidAfterReset).toEqual(expect.any(String));
    expect(result.uidAfterReset).not.toBe(result.initial);
  });

  test("A16-A18. public surface exposes only contract values, not Firebase Auth/User", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(async () => {
      const publicKeys = Object.keys(window.__step87Auth.adapter);

      const uid = await window.__step87Auth.resolveOwnerUid();

      const resetResult =
        await window.__step87Auth.requestAuthReset();

      return {
        publicKeys,
        uidType: typeof uid,
        uid,
        resetResult,
        hasAuthProperty: Object.prototype.hasOwnProperty.call(
          window.__step87Auth.adapter,
          "auth"
        ),
        hasUserProperty: Object.prototype.hasOwnProperty.call(
          window.__step87Auth.adapter,
          "user"
        ),
      };
    });

    expect(result.publicKeys.sort()).toEqual([
      "requestAuthReset",
      "resolveOwnerUid",
    ]);

    expect(result.uidType).toBe("string");
    expect(result.uid.length).toBeGreaterThan(0);
    expect(result.resetResult).toBeUndefined();
    expect(result.hasAuthProperty).toBe(false);
    expect(result.hasUserProperty).toBe(false);
  });

  test("A19-A20. production guard and forbidden dependency guard", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");
    await expect(page.locator("#status")).toHaveText("READY");

    const result = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;

      return {
        emulatorConnected:
          window.__step87Auth.testState.emulatorConnected,
        emulatorUrl:
          window.__step87Auth.testState.emulatorUrl,
        projectId:
          window.__step87Auth.testState.projectId,
        containsFirestore: /firestore/i.test(html),
        containsFunctions: /functions/i.test(html),
        containsMidtrans: /midtrans/i.test(html),
        containsQris: /qris/i.test(html),
      };
    });

    expect(result.emulatorConnected).toBe(true);
    expect(result.emulatorUrl).toBe("http://127.0.0.1:9099");
    expect(result.projectId).toBe("demo-no-project");

    expect(result.containsFirestore).toBe(false);
    expect(result.containsFunctions).toBe(false);
    expect(result.containsMidtrans).toBe(false);
    expect(result.containsQris).toBe(false);
  });

  test("A21-A22. adapter artifact remains isolated from forbidden runtime dependencies", async ({ page }) => {
    await page.goto("/browser-test/authHarness.html");

    const result = await page.evaluate(async () => {
      const response = await fetch("/dist/firebaseAuthAdapter.js");
      const source = await response.text();

      return {
        hasFirebaseSdkImport: /firebase-app|firebase-auth|gstatic/i.test(source),
        hasFirestore: /firestore/i.test(source),
        hasFunctions: /cloudfunctions|httpsCallable|getFunctions/i.test(source),
        hasOrderIntent: /orderIntent/i.test(source),
        hasIndexedDb: /indexedDB|indexedDb/i.test(source),
        hasMidtrans: /midtrans/i.test(source),
        hasQris: /qris/i.test(source),
      };
    });

    expect(result.hasFirebaseSdkImport).toBe(false);
    expect(result.hasFirestore).toBe(false);
    expect(result.hasFunctions).toBe(false);
    expect(result.hasOrderIntent).toBe(false);
    expect(result.hasIndexedDb).toBe(false);
    expect(result.hasMidtrans).toBe(false);
    expect(result.hasQris).toBe(false);
  });
});