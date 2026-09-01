/**
 * AUL's Kitchen — Cloud Functions entry point.
 *
 * SCOPE 22 STATE: `healthCheck` (infrastructure, Scope 16) and
 * `orderIntent` (business logic, Scope 22) are exported.
 *
 * Total locked function set = 6 (per owner decision following the
 * Scope 21 "5 vs 6" architecture consistency finding):
 *   1. healthCheck        — infrastructure (DONE, Scope 16)
 *   2. orderIntent         — DONE, Scope 22
 *   3. paymentInitiate      — NOT YET IMPLEMENTED
 *   4. paymentWebhook       — NOT YET IMPLEMENTED
 *   5. orderStatus          — NOT YET IMPLEMENTED
 *   6. reservationExpiry    — NOT YET IMPLEMENTED
 *
 * Do NOT add paymentInitiate, paymentWebhook, orderStatus,
 * reservationExpiry, or any other function here in this scope. Those
 * belong to later, separately-approved implementation scopes per the
 * Scope 14A blueprint and the project's "one clear scope at a time"
 * discipline.
 */

const { initializeApp } = require("firebase-admin/app");

// Initializes the Admin SDK once for this Functions deployment.
// Uses the deployed environment's default project (auls-kitchen) and
// default service account — no credentials are hardcoded here.
initializeApp();

const { healthCheck } = require("./src/functions/healthCheck");
const { orderIntent } = require("./src/functions/orderIntent");

module.exports = {
  healthCheck,
  orderIntent,
};
