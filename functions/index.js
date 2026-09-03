/**
 * AUL's Kitchen — Cloud Functions entry point.
 *
 * SCOPE 23C STATE:
 * - healthCheck — infrastructure, Scope 16
 * - orderIntent — Kiosk OrderIntent boundary, Scope 22
 * - posSale — POS trusted sale boundary, Scope 23C
 *
 * Other planned functions remain intentionally unexported until
 * their separately approved implementation scopes.
 */

const { initializeApp } = require("firebase-admin/app");

// Initializes the Admin SDK once for this Functions deployment.
// Uses the deployed environment's default project and service account.
// No credentials are hardcoded here.
initializeApp();

const { healthCheck } = require("./src/functions/healthCheck");
const { orderIntent } = require("./src/functions/orderIntent");
const { posSale } = require("./src/functions/posSale");

module.exports = {
  healthCheck,
  orderIntent,
  posSale,
};
