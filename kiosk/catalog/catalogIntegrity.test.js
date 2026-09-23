"use strict";

/**
 * Kiosk Catalog integrity tests (canonical SHA-256).
 *
 * Run with: node --test kiosk/catalog/catalogIntegrity.test.js
 * Uses Node's built-in WebCrypto (globalThis.crypto.subtle) - the same
 * API the browser provides - and cross-checks against the publisher's
 * own functions/src/domain modules.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const integrity = require("./catalogIntegrity");
const contract = require("./catalogContract");
const { buildCatalogPublishPlan } = require("../../functions/src/domain/catalogPublishPlan");

const SNAPSHOT_FILE = path.join(__dirname, "fixtures", "catalogV1Snapshot.json");
const liveSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
const LIVE_REVISION = "1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- C. SHA-256 verification ---

test("C1. canonical SHA-256 of the live V1 products equals the published revision", async () => {
  assert.equal(await integrity.computeCatalogRevision(liveSnapshot.products), LIVE_REVISION);
});

test("C2. the raw snapshot bytes do NOT hash to the revision (why canonicalization is required)", () => {
  const rawHash = nodeCrypto.createHash("sha256").update(fs.readFileSync(SNAPSHOT_FILE)).digest("hex");
  assert.notEqual(rawHash, LIVE_REVISION);
});

test("C3. the consumer hash matches the publisher's own plan revision for the same products", async () => {
  const raw = [
    { id: "b", name: "B", price: 5000, category: "tea", categoryLabel: "Tea", categoryOrder: 2, itemOrder: 1, recipe: [{ ingredientId: "x", qty: 1 }] },
    {
      id: "a", name: "A", price: 9000, category: "coffee", categoryLabel: "Coffee", categoryOrder: 1, itemOrder: 1,
      imageUrl: "https://example.invalid/a.webp",
      modifierGroups: [{ id: "g", name: "Sugar", selectionType: "single", required: false, options: [{ id: "o1", name: "Normal", price: 0, isDefault: true }] }],
    },
  ];
  const plan = buildCatalogPublishPlan(raw);
  assert.equal(plan.ok, true);
  assert.equal(await integrity.computeCatalogRevision(plan.products), plan.revision);
});

test("C4. canonicalization is order-independent at the product level (publisher sort rules)", async () => {
  const reversed = clone(liveSnapshot.products).reverse();
  assert.equal(await integrity.computeCatalogRevision(reversed), LIVE_REVISION);
});

// --- D/E/F. acceptance and rejection ---

test("D1. a valid snapshot verifies", async () => {
  await integrity.verifySnapshotIntegrity(contract.parseSnapshot(clone(liveSnapshot), LIVE_REVISION));
});

test("F1. any content change breaks integrity (INTEGRITY_MISMATCH)", async () => {
  const tampered = clone(liveSnapshot);
  tampered.products[5].price += 1000;
  await assert.rejects(
    integrity.verifySnapshotIntegrity(tampered),
    (error) => error instanceof contract.CatalogError && error.code === contract.CATALOG_ERROR_CODES.INTEGRITY_MISMATCH
  );
});

test("F2. a snapshot re-labelled with another revision fails integrity", async () => {
  const relabelled = clone(liveSnapshot);
  relabelled.revision = "a".repeat(64);
  await assert.rejects(integrity.verifySnapshotIntegrity(relabelled), (error) => error.code === "INTEGRITY_MISMATCH");
});
