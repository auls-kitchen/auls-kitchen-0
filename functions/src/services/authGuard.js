/**
 * authGuard (services)
 *
 * Rejects any callable invocation lacking a verified Firebase Auth
 * context. Per Scope 10, this project uses Anonymous Auth — this
 * guard does not care WHICH auth provider was used, only that
 * `context.auth` is genuinely present.
 */

const { HttpsError } = require("firebase-functions/v2/https");

/**
 * @param {import("firebase-functions/v2/https").CallableRequest} request
 * @returns {string} the authenticated UID
 * @throws {HttpsError} "unauthenticated" if request.auth is missing
 */
function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Sign-in is required.");
  }
  return request.auth.uid;
}

module.exports = { requireAuth };
