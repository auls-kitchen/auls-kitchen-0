const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const { runCatalogPublish } = require("../../src/functions/catalogPublish");

function validRaw(overrides = {}) {
  return {
    id: "prod1",
    name: "Java Aren",
    price: 10000,
    category: "coffee",
    categoryLabel: "Coffee",
    categoryOrder: 1,
    itemOrder: 1,
    ...overrides,
  };
}

// Real, unmocked pure logic — reused exactly as the real callable
// would, so these tests exercise the actual validation/projection/
// canonicalization/hash pipeline, not a fake stand-in for it.
const { buildCatalogPublishPlan } = require("../../src/domain/catalogPublishPlan");

function makeStorageStubs({ snapshotCreated = true } = {}) {
  const calls = [];
  return {
    calls,
    writeSnapshotIfAbsent: async (revision, snapshotJson) => {
      calls.push({ fn: "writeSnapshotIfAbsent", revision, snapshotJson });
      return { created: snapshotCreated, path: `catalog/${revision}.json` };
    },
    writeManifest: async (revision) => {
      calls.push({ fn: "writeManifest", revision });
      return { path: "catalog/manifest.json", snapshotPath: `/catalog/${revision}.json` };
    },
  };
}

test("successful authorized publish returns revision/productCount/publishedPath", async () => {
  const { writeSnapshotIfAbsent, writeManifest } = makeStorageStubs();
  const result = await runCatalogPublish({
    invokedAt: new Date().toISOString(),
    listProducts: async () => [validRaw()],
    buildCatalogPublishPlan,
    writeSnapshotIfAbsent,
    writeManifest,
  });

  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.equal(result.productCount, 1);
  assert.equal(result.publishedPath, `/catalog/${result.revision}.json`);
});

test("a malformed product prevents publication entirely — no Storage write occurs", async () => {
  const { writeSnapshotIfAbsent, writeManifest, calls } = makeStorageStubs();

  await assert.rejects(
    () =>
      runCatalogPublish({
        invokedAt: new Date().toISOString(),
        listProducts: async () => [validRaw({ id: "good" }), validRaw({ id: "bad", name: "" })],
        buildCatalogPublishPlan,
        writeSnapshotIfAbsent,
        writeManifest,
      }),
    (err) => {
      assert.ok(err instanceof HttpsError);
      assert.equal(err.code, "failed-precondition");
      assert.equal(err.details.reason, "VALIDATION_FAILED");
      assert.equal(err.details.validationFailureCount, 1);
      assert.deepEqual(err.details.affectedProductIds, ["bad"]);
      return true;
    }
  );

  assert.equal(calls.length, 0); // no snapshot write, no manifest update
});

test("snapshot write happens before manifest update", async () => {
  const { writeSnapshotIfAbsent, writeManifest, calls } = makeStorageStubs();

  await runCatalogPublish({
    invokedAt: new Date().toISOString(),
    listProducts: async () => [validRaw()],
    buildCatalogPublishPlan,
    writeSnapshotIfAbsent,
    writeManifest,
  });

  assert.deepEqual(calls.map((c) => c.fn), ["writeSnapshotIfAbsent", "writeManifest"]);
});

test("an existing snapshot revision (idempotent, created: false) still succeeds and updates the manifest", async () => {
  const { writeSnapshotIfAbsent, writeManifest, calls } = makeStorageStubs({ snapshotCreated: false });

  const result = await runCatalogPublish({
    invokedAt: new Date().toISOString(),
    listProducts: async () => [validRaw()],
    buildCatalogPublishPlan,
    writeSnapshotIfAbsent,
    writeManifest,
  });

  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls.map((c) => c.fn), ["writeSnapshotIfAbsent", "writeManifest"]); // manifest still updated
});

test("publishing the same logical catalog twice yields the same revision", async () => {
  const { writeSnapshotIfAbsent, writeManifest } = makeStorageStubs();
  const listProducts = async () => [validRaw()];

  const resultA = await runCatalogPublish({
    invokedAt: new Date().toISOString(),
    listProducts,
    buildCatalogPublishPlan,
    writeSnapshotIfAbsent,
    writeManifest,
  });
  const resultB = await runCatalogPublish({
    invokedAt: new Date().toISOString(),
    listProducts,
    buildCatalogPublishPlan,
    writeSnapshotIfAbsent,
    writeManifest,
  });

  assert.equal(resultA.revision, resultB.revision);
});
