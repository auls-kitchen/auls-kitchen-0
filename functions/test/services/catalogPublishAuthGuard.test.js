const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const { requireCatalogPublishAuthorization } = require("../../src/services/catalogPublishAuthGuard");

const OWNER_UID = "IXgT0vd5cqM4M8q7Sg4fxzGiOrp1";

test("unauthenticated request is rejected", () => {
  assert.throws(
    () => requireCatalogPublishAuthorization({ auth: null }),
    (err) => err instanceof HttpsError && err.code === "unauthenticated"
  );
});

test("anonymous Kiosk auth (a real but non-owner UID) is rejected", () => {
  // Anonymous Auth UIDs are opaque random strings — this is any such
  // UID, standing in for a genuine Kiosk Anonymous Auth session.
  assert.throws(
    () => requireCatalogPublishAuthorization({ auth: { uid: "someRandomAnonymousUid123" } }),
    (err) => err instanceof HttpsError && err.code === "permission-denied"
  );
});

test("an authenticated but non-allowlisted UID is rejected", () => {
  assert.throws(
    () => requireCatalogPublishAuthorization({ auth: { uid: "someOtherRealAccountUid" } }),
    (err) => err instanceof HttpsError && err.code === "permission-denied"
  );
});

test("the exact allowlisted Owner UID is accepted", () => {
  const result = requireCatalogPublishAuthorization({ auth: { uid: OWNER_UID } });
  assert.equal(result, OWNER_UID);
});

test("requireAuth() alone is not the mechanism — provider is irrelevant, only UID matters", () => {
  // Even a "password"-provider-shaped auth context is rejected if the
  // UID itself isn't the allowlisted owner — proving this guard does
  // NOT fall back to a sign-in-provider check.
  assert.throws(
    () =>
      requireCatalogPublishAuthorization({
        auth: { uid: "someOtherPasswordUser", token: { firebase: { sign_in_provider: "password" } } },
      }),
    (err) => err instanceof HttpsError && err.code === "permission-denied"
  );
});
