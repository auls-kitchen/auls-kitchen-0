/**
 * catalogPublishAuthGuard (services)
 *
 * Server-side authorization boundary for Catalog Publish (Step 2G
 * Phase C, Step 2F Gate 2 — LOCKED).
 *
 * `requireAuth()` (authGuard.js) only proves that SOME Firebase Auth
 * context exists — by its own doc comment, it "does not care WHICH
 * auth provider was used." The Kiosk's Anonymous Auth satisfies it
 * just as well as the Admin's email/password login. That makes it
 * explicitly INSUFFICIENT for Publish (Step 2F Gate 2 finding) — this
 * guard composes `requireAuth()` with a second, identity-specific
 * check on top, never relying on it alone.
 *
 * V1 mechanism (LOCKED, Owner-supplied 2026-09-23): an explicit,
 * single-entry UID allowlist. Not a role/custom-claim system — a
 * deliberately minimal, V1-specific check. The UID is never logged,
 * never returned to any client, and never sourced from anything
 * client-controlled.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { requireAuth } = require("./authGuard");

// V1 Owner/Admin allowlist for Catalog Publish — exactly one entry,
// supplied directly by the Owner. Deliberately not derived from email,
// sign-in provider, or any other indirect/spoofable signal.
const CATALOG_PUBLISH_OWNER_UIDS = new Set(["IXgT0vd5cqM4M8q7Sg4fxzGiOrp1"]);

/**
 * @param {import("firebase-functions/v2/https").CallableRequest} request
 * @returns {string} the authorized owner UID
 * @throws {HttpsError} "unauthenticated" if no auth context exists at all
 *   (delegated to `requireAuth()`); "permission-denied" if authenticated
 *   but the UID is not on the allowlist — this is the path that rejects
 *   the Kiosk's Anonymous Auth (and any other non-owner account), since
 *   no such UID can ever be a member of this allowlist.
 */
function requireCatalogPublishAuthorization(request) {
  const uid = requireAuth(request);

  if (!CATALOG_PUBLISH_OWNER_UIDS.has(uid)) {
    throw new HttpsError("permission-denied", "Not authorized to publish the Catalog.");
  }

  return uid;
}

module.exports = { requireCatalogPublishAuthorization };
