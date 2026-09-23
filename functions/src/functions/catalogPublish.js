/**
 * catalogPublish
 *
 * Step 2G Phase C — Catalog Publish callable Function.
 *
 * Trusted flow (Step 2F Gate 5/8, LOCKED):
 *
 *   authorize (owner-only, distinct from mere authentication)
 *   -> enumerate Product Master (complete collection)
 *   -> validate + project + canonicalize + hash (pure, D1 fail-whole-publish)
 *   -> if invalid: reject, NO Storage write of any kind
 *   -> write immutable snapshot (create-if-absent, idempotent)
 *   -> update manifest (only after snapshot succeeded)
 *   -> return { revision, productCount, publishedPath }
 *
 * The Admin UI (aul-adm.html) never enumerates products, never
 * computes the revision, and never writes Storage directly — this
 * callable owns the entire operation (Step 2F Gate 8, LOCKED).
 *
 * `runCatalogPublish()` is exported separately from the `onCall`
 * wrapper so it can be unit-tested with injected repository/plan
 * functions, without any live Firestore/Storage dependency — matching
 * this project's existing pattern of keeping pure/composable logic
 * testable without production deployment.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");

const { requireCatalogPublishAuthorization } = require("../services/catalogPublishAuthGuard");
const { listProducts: defaultListProducts } = require("../repositories/productsRepo");
const { buildCatalogPublishPlan: defaultBuildCatalogPublishPlan } = require("../domain/catalogPublishPlan");
const {
  writeSnapshotIfAbsent: defaultWriteSnapshotIfAbsent,
  writeManifest: defaultWriteManifest,
} = require("../repositories/catalogStorageRepo");

/**
 * The orchestration core, with every I/O/logic dependency injectable
 * for testing. The real `catalogPublish` callable below always calls
 * this with the real repository/domain functions.
 *
 * @param {object} deps
 * @param {string} deps.invokedAt
 * @param {Function} deps.listProducts
 * @param {Function} deps.buildCatalogPublishPlan
 * @param {Function} deps.writeSnapshotIfAbsent
 * @param {Function} deps.writeManifest
 * @returns {Promise<{revision: string, productCount: number, publishedPath: string}>}
 * @throws {HttpsError} "failed-precondition" (validation failure, with
 *   `details = {reason, validationFailureCount, affectedProductIds}`)
 *   or whatever unexpected error occurs (left for the caller to map).
 */
async function runCatalogPublish({
  invokedAt,
  listProducts,
  buildCatalogPublishPlan,
  writeSnapshotIfAbsent,
  writeManifest,
}) {
  // Step 1: enumerate Product Master (complete collection).
  const rawProducts = await listProducts();

  // Step 2: validate + project + canonicalize + hash (pure, D1).
  const plan = buildCatalogPublishPlan(rawProducts);

  if (!plan.ok) {
    // D1 (LOCKED): entire publish fails. No snapshot write, no
    // manifest update — buildCatalogPublishPlan() already guaranteed
    // this by returning before producing a revision/products at all.
    const affectedProductIds = plan.validationFailures.map((f) => f.productId);
    logger.info("catalogPublish: validation failed", {
      functionId: "catalogPublish",
      invokedAt,
      validationFailureCount: plan.validationFailures.length,
      affectedProductIds,
    });

    throw new HttpsError("failed-precondition", "One or more products are not publishable.", {
      reason: "VALIDATION_FAILED",
      validationFailureCount: plan.validationFailures.length,
      affectedProductIds,
    });
  }

  // Step 3: write immutable snapshot (create-if-absent, idempotent —
  // an already-existing identical revision is success, not an error).
  const snapshotJson = JSON.stringify({ revision: plan.revision, products: plan.products });
  const snapshotResult = await writeSnapshotIfAbsent(plan.revision, snapshotJson);

  // Step 4: flip the manifest — ONLY after the snapshot write above
  // has already succeeded (Gate 5 step 8). If this throws, the
  // previous manifest object is untouched (it is a distinct object;
  // this call never partially writes it), so the previously-published
  // catalog remains active — the caller (the callable below) reports
  // the failure without needing to undo anything.
  await writeManifest(plan.revision);

  logger.info("catalogPublish: success", {
    functionId: "catalogPublish",
    invokedAt,
    revision: plan.revision,
    productCount: plan.productCount,
    snapshotCreated: snapshotResult.created,
  });

  return {
    revision: plan.revision,
    productCount: plan.productCount,
    publishedPath: `/${snapshotResult.path}`,
  };
}

const catalogPublish = onCall({ region: "us-central1" }, async (request) => {
  const invokedAt = new Date().toISOString();

  // Step 0: authorize. Owner-only — rejects both "no auth at all" and
  // "authenticated but not the owner" (including every Kiosk Anonymous
  // Auth session) before touching Product Master or Storage at all.
  // The return value (the UID) is deliberately not captured/logged —
  // with exactly one allowlisted owner, logging it would add no
  // diagnostic value while needlessly writing the Owner's UID into
  // Cloud Functions logs.
  requireCatalogPublishAuthorization(request);

  logger.info("catalogPublish: invoked", { functionId: "catalogPublish", invokedAt });

  try {
    return await runCatalogPublish({
      invokedAt,
      listProducts: defaultListProducts,
      buildCatalogPublishPlan: defaultBuildCatalogPublishPlan,
      writeSnapshotIfAbsent: defaultWriteSnapshotIfAbsent,
      writeManifest: defaultWriteManifest,
    });
  } catch (err) {
    if (err instanceof HttpsError) {
      // Already the correct client-safe shape (e.g. the validation
      // failure above) — pass through unchanged.
      throw err;
    }

    // Unexpected/internal failure. Full detail stays server-side only.
    logger.error("catalogPublish: internal failure", {
      functionId: "catalogPublish",
      invokedAt,
      errorMessage: err && err.message ? err.message : "unknown error",
    });

    throw new HttpsError(
      "internal",
      "Catalog publish could not be completed. Please try again."
    );
  }
});

module.exports = { catalogPublish, runCatalogPublish };
