/**
 * catalogStorageRepo
 *
 * Firebase Storage I/O for the Catalog Snapshot + Manifest (Step 2F/2G,
 * LOCKED). This module performs ONLY Storage reads/writes — no
 * projection, validation, canonicalization, or hashing logic lives
 * here (that is `functions/src/domain/catalogPublishPlan.js` and the
 * modules it composes). Mirrors this project's existing convention of
 * keeping I/O in `repositories/` and pure logic in `domain/`
 * (`functions/src/repositories/productsRepo.js`).
 *
 * Uses the same Admin SDK Storage path already runtime-verified in
 * Steps 2C/2D/2E (write/read-metadata/delete, bucket CORS) — no new
 * dependency, no new bucket, no Storage Rules change.
 *
 * Paths (Step 2F, LOCKED):
 *   manifest:           catalog/manifest.json          (mutable pointer)
 *   immutable snapshot: catalog/<revision>.json         (write-once)
 *
 * Cache-Control (Step 2F Gate 6, LOCKED):
 *   manifest:  no-cache
 *   snapshot:  public, max-age=31536000, immutable
 */

const { getStorage } = require("firebase-admin/storage");

const CATALOG_MANIFEST_PATH = "catalog/manifest.json";

function snapshotPathForRevision(revision) {
  return `catalog/${revision}.json`;
}

/**
 * A GCS/Storage API error whose HTTP status is 412 (Precondition
 * Failed) is exactly what `ifGenerationMatch: 0` produces when the
 * target object already exists. VERIFIED against the installed
 * `@google-cloud/storage` client (`ApiError` sets `.code` from the
 * response HTTP status — `nodejs-common/util.js`), not assumed from
 * general documentation alone.
 *
 * Exported standalone so it can be unit-tested without any real
 * Storage call.
 */
function isPreconditionFailedError(err) {
  return Boolean(err) && err.code === 412;
}

/**
 * Write the immutable Catalog Snapshot at `catalog/<revision>.json`,
 * using create-if-absent semantics (Step 2F Gate 5, LOCKED).
 *
 * If the object already exists (same revision published before, or a
 * concurrent publish reaching the same content-derived path), this is
 * treated as idempotent success — the existing immutable object is
 * never overwritten, and no error is thrown (Step 2F Gate 5/Part O).
 *
 * @param {string} revision - lowercase hex SHA-256, from catalogRevision.js
 * @param {string} snapshotJson - the exact JSON string to write (already
 *   built by the caller as `JSON.stringify({ revision, products })`)
 * @returns {Promise<{ created: boolean, path: string }>}
 *   `created: false` means the object already existed (idempotent path).
 */
async function writeSnapshotIfAbsent(revision, snapshotJson) {
  const path = snapshotPathForRevision(revision);
  const bucket = getStorage().bucket();
  const file = bucket.file(path);

  try {
    await file.save(snapshotJson, {
      contentType: "application/json",
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return { created: true, path };
  } catch (err) {
    if (isPreconditionFailedError(err)) {
      return { created: false, path };
    }
    throw err;
  }
}

/**
 * Update the mutable manifest at `catalog/manifest.json` to point at
 * the given revision. Unconditional overwrite — the manifest is the
 * one deliberately mutable pointer in this design (Step 2F Gate 5/J).
 *
 * MUST only be called after `writeSnapshotIfAbsent()` for the same
 * revision has already succeeded (Gate 5 step 8) — this function does
 * not itself verify that; the publish callable (Phase C) owns that
 * ordering.
 *
 * @param {string} revision
 * @returns {Promise<{ path: string, snapshotPath: string }>}
 */
async function writeManifest(revision) {
  const snapshotPath = `/${snapshotPathForRevision(revision)}`;
  const manifestJson = JSON.stringify({ revision, snapshotPath });

  const bucket = getStorage().bucket();
  const file = bucket.file(CATALOG_MANIFEST_PATH);
  await file.save(manifestJson, {
    contentType: "application/json",
    metadata: { cacheControl: "no-cache" },
  });

  return { path: CATALOG_MANIFEST_PATH, snapshotPath };
}

/**
 * Read the current manifest, if one exists. Used only for
 * verification/observability — never required by the publish sequence
 * itself.
 *
 * @returns {Promise<{revision: string, snapshotPath: string} | null>}
 */
async function readManifest() {
  const bucket = getStorage().bucket();
  const file = bucket.file(CATALOG_MANIFEST_PATH);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return JSON.parse(contents.toString("utf8"));
}

module.exports = {
  CATALOG_MANIFEST_PATH,
  snapshotPathForRevision,
  isPreconditionFailedError,
  writeSnapshotIfAbsent,
  writeManifest,
  readManifest,
};
