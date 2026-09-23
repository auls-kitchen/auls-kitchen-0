"use strict";

/**
 * Kiosk Catalog contract - shapes, constants and pure structural
 * validation for the Published Catalog (manifest + immutable snapshot).
 * No I/O, no hashing, no Firebase, no Firestore.
 *
 * Mirrors the publisher contract in functions/src/domain/
 * (catalogProjection.js / catalogStorageRepo.js, Catalog Publish V1):
 *
 *   manifest: { revision: "<sha256>", snapshotPath: "/catalog/<sha256>.json" }
 *   snapshot: { revision: "<sha256>", products: [CatalogProduct...] }
 *
 *   CatalogProduct: productId, name, category, categoryLabel,
 *     categoryOrder, itemOrder, price, imageUrl?, modifierGroups?
 *   ModifierGroup:  id, name, selectionType, required, options
 *   ModifierOption: id, name, price, isDefault
 *
 * Only this customer-safe contract is accepted. A key outside it (for
 * example recipe, stock, cost, categoryColorVar) makes the whole
 * snapshot invalid - the Kiosk never receives, stores or depends on
 * Product Master internals.
 */

const CATALOG_MANIFEST_OBJECT_PATH = "catalog/manifest.json";
const REVISION_PATTERN = /^[0-9a-f]{64}$/;

const PRODUCT_KEYS = Object.freeze([
  "productId",
  "name",
  "category",
  "categoryLabel",
  "categoryOrder",
  "itemOrder",
  "price",
  "imageUrl",
  "modifierGroups",
]);
const GROUP_KEYS = Object.freeze(["id", "name", "selectionType", "required", "options"]);
const OPTION_KEYS = Object.freeze(["id", "name", "price", "isDefault"]);

/** Stable, machine-readable failure codes (never carry catalog data). */
const CATALOG_ERROR_CODES = Object.freeze({
  MANIFEST_UNAVAILABLE: "MANIFEST_UNAVAILABLE",
  MANIFEST_MALFORMED: "MANIFEST_MALFORMED",
  SNAPSHOT_UNAVAILABLE: "SNAPSHOT_UNAVAILABLE",
  SNAPSHOT_MALFORMED: "SNAPSHOT_MALFORMED",
  SNAPSHOT_REVISION_MISMATCH: "SNAPSHOT_REVISION_MISMATCH",
  PRODUCT_CONTRACT_VIOLATION: "PRODUCT_CONTRACT_VIOLATION",
  INTEGRITY_MISMATCH: "INTEGRITY_MISMATCH",
});

class CatalogError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "CatalogError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

function snapshotPathForRevision(revision) {
  return "/catalog/" + revision + ".json";
}

/**
 * @returns {{revision: string, snapshotPath: string}} the manifest's two
 *   contract fields (anything else in the object is ignored, not kept)
 * @throws {CatalogError} MANIFEST_MALFORMED
 */
function parseManifest(raw) {
  if (!isPlainObject(raw)) {
    throw new CatalogError(CATALOG_ERROR_CODES.MANIFEST_MALFORMED, "manifest is not an object");
  }
  if (typeof raw.revision !== "string" || !REVISION_PATTERN.test(raw.revision)) {
    throw new CatalogError(CATALOG_ERROR_CODES.MANIFEST_MALFORMED, "manifest revision is missing or not a sha256 hex string");
  }
  // The snapshot must live at the content-addressed path of the very
  // revision the manifest names - a manifest pointing anywhere else is
  // rejected rather than followed.
  if (raw.snapshotPath !== snapshotPathForRevision(raw.revision)) {
    throw new CatalogError(CATALOG_ERROR_CODES.MANIFEST_MALFORMED, "manifest snapshotPath does not match its revision");
  }
  return { revision: raw.revision, snapshotPath: raw.snapshotPath };
}

function isValidOption(option) {
  return (
    isPlainObject(option) &&
    hasOnlyKeys(option, OPTION_KEYS) &&
    isNonBlankString(option.id) &&
    isNonBlankString(option.name) &&
    isFiniteNumber(option.price) &&
    option.price >= 0 &&
    typeof option.isDefault === "boolean"
  );
}

function isValidGroup(group) {
  return (
    isPlainObject(group) &&
    hasOnlyKeys(group, GROUP_KEYS) &&
    isNonBlankString(group.id) &&
    isNonBlankString(group.name) &&
    isNonBlankString(group.selectionType) &&
    typeof group.required === "boolean" &&
    Array.isArray(group.options) &&
    group.options.length > 0 &&
    group.options.every(isValidOption)
  );
}

/** @returns {boolean} whether one product matches the customer-safe contract exactly */
function isValidCatalogProduct(product) {
  if (!isPlainObject(product) || !hasOnlyKeys(product, PRODUCT_KEYS)) return false;
  if (!isNonBlankString(product.productId)) return false;
  if (!isNonBlankString(product.name)) return false;
  if (!isNonBlankString(product.category) || !isNonBlankString(product.categoryLabel)) return false;
  if (!isFiniteNumber(product.categoryOrder) || !isFiniteNumber(product.itemOrder)) return false;
  if (!isFiniteNumber(product.price) || product.price <= 0) return false;
  // Optional fields are omitted by the publisher when absent - never
  // null, never empty (catalogProjection.js, LOCKED).
  if ("imageUrl" in product && !isNonBlankString(product.imageUrl)) return false;
  if ("modifierGroups" in product) {
    if (!Array.isArray(product.modifierGroups) || product.modifierGroups.length === 0) return false;
    if (!product.modifierGroups.every(isValidGroup)) return false;
  }
  return true;
}

/**
 * Structural validation of a fetched snapshot against the revision the
 * manifest announced. Integrity (SHA-256) is checked separately, in
 * catalogIntegrity.js.
 *
 * @returns {{revision: string, products: object[]}}
 * @throws {CatalogError} SNAPSHOT_MALFORMED | SNAPSHOT_REVISION_MISMATCH | PRODUCT_CONTRACT_VIOLATION
 */
function parseSnapshot(raw, expectedRevision) {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["revision", "products"])) {
    throw new CatalogError(CATALOG_ERROR_CODES.SNAPSHOT_MALFORMED, "snapshot is not a {revision, products} object");
  }
  if (typeof raw.revision !== "string" || !REVISION_PATTERN.test(raw.revision)) {
    throw new CatalogError(CATALOG_ERROR_CODES.SNAPSHOT_MALFORMED, "snapshot revision is missing or not a sha256 hex string");
  }
  if (raw.revision !== expectedRevision) {
    throw new CatalogError(CATALOG_ERROR_CODES.SNAPSHOT_REVISION_MISMATCH, "snapshot revision differs from the manifest revision");
  }
  if (!Array.isArray(raw.products)) {
    throw new CatalogError(CATALOG_ERROR_CODES.SNAPSHOT_MALFORMED, "snapshot products is not an array");
  }
  const seenIds = new Set();
  for (const product of raw.products) {
    if (!isValidCatalogProduct(product) || seenIds.has(product.productId)) {
      throw new CatalogError(CATALOG_ERROR_CODES.PRODUCT_CONTRACT_VIOLATION, "snapshot contains a product outside the catalog contract");
    }
    seenIds.add(product.productId);
  }
  return { revision: raw.revision, products: raw.products };
}

module.exports = {
  CATALOG_MANIFEST_OBJECT_PATH,
  REVISION_PATTERN,
  PRODUCT_KEYS,
  GROUP_KEYS,
  OPTION_KEYS,
  CATALOG_ERROR_CODES,
  CatalogError,
  snapshotPathForRevision,
  parseManifest,
  parseSnapshot,
  isValidCatalogProduct,
};
