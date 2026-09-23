const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CATALOG_MANIFEST_PATH,
  snapshotPathForRevision,
  isPreconditionFailedError,
} = require("../../src/repositories/catalogStorageRepo");

// These cover only the pure, no-I/O pieces of this repository module —
// path construction and error classification. The actual Storage I/O
// (writeSnapshotIfAbsent/writeManifest/readManifest) requires a live
// Admin SDK Storage connection and is verified separately via a
// temporary probe function (see the Phase B report), matching this
// project's existing pattern (Steps 2C/2D/2E) rather than requiring
// production deployment just to test pure logic.

test("manifest path is the locked, fixed path", () => {
  assert.equal(CATALOG_MANIFEST_PATH, "catalog/manifest.json");
});

test("snapshot path is content-addressed under catalog/", () => {
  assert.equal(
    snapshotPathForRevision("abc123"),
    "catalog/abc123.json"
  );
});

test("a 412 error is classified as precondition-failed (idempotent path)", () => {
  const err = new Error("Precondition Failed");
  err.code = 412;
  assert.equal(isPreconditionFailedError(err), true);
});

test("a non-412 error is NOT classified as precondition-failed", () => {
  const err = new Error("Forbidden");
  err.code = 403;
  assert.equal(isPreconditionFailedError(err), false);
});

test("a missing/undefined error is not classified as precondition-failed", () => {
  assert.equal(isPreconditionFailedError(undefined), false);
  assert.equal(isPreconditionFailedError(null), false);
  assert.equal(isPreconditionFailedError({}), false);
});
