"use strict";

/**
 * Kiosk Catalog contract tests (manifest + snapshot structure).
 *
 * Run with: node --test kiosk/catalog/catalogContract.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const contract = require("./catalogContract");
const liveManifest = require("./fixtures/catalogV1Manifest.json");
const liveSnapshot = require("./fixtures/catalogV1Snapshot.json");

const { CATALOG_ERROR_CODES: CODES } = contract;
const REV = liveManifest.revision;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof contract.CatalogError && error.code === code);
}

// --- A. Manifest validation ---

test("A1. the live V1 manifest parses to exactly {revision, snapshotPath}", () => {
  assert.deepEqual(contract.parseManifest(clone(liveManifest)), {
    revision: REV,
    snapshotPath: "/catalog/" + REV + ".json",
  });
});

test("A2. non-object manifests are MANIFEST_MALFORMED", () => {
  for (const raw of [null, undefined, "x", 42, [], true]) {
    assertCode(() => contract.parseManifest(raw), CODES.MANIFEST_MALFORMED);
  }
});

test("A3. missing / non-sha256 revision is MANIFEST_MALFORMED", () => {
  for (const revision of [undefined, "", "abc", REV.toUpperCase(), REV + "0", 123]) {
    assertCode(() => contract.parseManifest({ revision, snapshotPath: "/catalog/" + revision + ".json" }), CODES.MANIFEST_MALFORMED);
  }
});

test("A4. a snapshotPath that is not the revision's own path is rejected", () => {
  const other = "0".repeat(64);
  for (const snapshotPath of [undefined, "", "catalog/" + REV + ".json", "/catalog/" + other + ".json", "https://evil.example/" + REV + ".json", "/catalog/../" + REV + ".json"]) {
    assertCode(() => contract.parseManifest({ revision: REV, snapshotPath }), CODES.MANIFEST_MALFORMED);
  }
});

test("A5. extra manifest keys are ignored, not carried forward", () => {
  const parsed = contract.parseManifest(Object.assign(clone(liveManifest), { extra: "x" }));
  assert.deepEqual(Object.keys(parsed).sort(), ["revision", "snapshotPath"]);
});

// --- B. Snapshot validation ---

test("B1. the live V1 snapshot parses: 36 products, revision kept", () => {
  const parsed = contract.parseSnapshot(clone(liveSnapshot), REV);
  assert.equal(parsed.revision, REV);
  assert.equal(parsed.products.length, 36);
});

test("B2. snapshot revision must equal the manifest revision", () => {
  assertCode(() => contract.parseSnapshot(clone(liveSnapshot), "f".repeat(64)), CODES.SNAPSHOT_REVISION_MISMATCH);
});

test("B3. malformed snapshot envelopes are SNAPSHOT_MALFORMED", () => {
  const cases = [
    null,
    [],
    { revision: REV },
    { revision: REV, products: {} },
    { revision: "nope", products: [] },
    { revision: REV, products: [], extra: 1 },
  ];
  for (const raw of cases) {
    assertCode(() => contract.parseSnapshot(raw, REV), CODES.SNAPSHOT_MALFORMED);
  }
});

test("B4. forbidden internal fields anywhere make the snapshot invalid", () => {
  const injections = [
    (s) => { s.products[0].recipe = []; },
    (s) => { s.products[1].stock = 3; },
    (s) => { s.products[2].avgCost = 100; },
    (s) => { s.products[3].categoryColorVar = "--x"; },
    (s) => { s.products[0].modifierGroups[0].recipe = []; },
    (s) => { s.products[0].modifierGroups[0].options[0].ingredientId = "i1"; },
  ];
  for (const inject of injections) {
    const snapshot = clone(liveSnapshot);
    inject(snapshot);
    assertCode(() => contract.parseSnapshot(snapshot, REV), CODES.PRODUCT_CONTRACT_VIOLATION);
  }
});

test("B5. product field violations are PRODUCT_CONTRACT_VIOLATION", () => {
  const mutations = [
    (p) => { delete p.productId; },
    (p) => { p.name = " "; },
    (p) => { p.price = 0; },
    (p) => { p.price = "9000"; },
    (p) => { p.categoryOrder = null; },
    (p) => { p.itemOrder = NaN; },
    (p) => { p.imageUrl = ""; },
    (p) => { p.modifierGroups = []; },
    (p) => { p.modifierGroups[0].options = []; },
    (p) => { p.modifierGroups[0].required = "no"; },
    (p) => { p.modifierGroups[0].options[0].isDefault = 1; },
    (p) => { p.modifierGroups[0].options[0].price = -1; },
  ];
  for (const mutate of mutations) {
    const snapshot = clone(liveSnapshot);
    mutate(snapshot.products[0]); // coffee__ori-ala-aul: has imageUrl and a modifier group
    assertCode(() => contract.parseSnapshot(snapshot, REV), CODES.PRODUCT_CONTRACT_VIOLATION);
  }
});

test("B6. duplicate productIds are rejected", () => {
  const snapshot = clone(liveSnapshot);
  snapshot.products[1].productId = snapshot.products[0].productId;
  assertCode(() => contract.parseSnapshot(snapshot, REV), CODES.PRODUCT_CONTRACT_VIOLATION);
});

test("B7. imageUrl presence and absence are both valid and preserved as-is", () => {
  const parsed = contract.parseSnapshot(clone(liveSnapshot), REV);
  const withImage = parsed.products.filter((p) => "imageUrl" in p);
  assert.equal(withImage.length, 1);
  assert.equal(withImage[0].productId, "coffee__ori-ala-aul");
  assert.ok(parsed.products.filter((p) => !("imageUrl" in p)).every((p) => p.imageUrl === undefined));
});
