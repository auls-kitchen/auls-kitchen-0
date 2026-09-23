/**
 * catalogValidation (domain)
 *
 * Pure business logic — no Firestore I/O, no external calls.
 *
 * Determines whether a single Product Master document is publishable
 * into the customer-safe Catalog Snapshot (Step 2F Gate 3, LOCKED).
 *
 * This module does NOT decide what happens when a product is invalid
 * (that is the publish orchestrator's job — Gate 3's D1 rule: any
 * fatal error on any product fails the ENTIRE publish, no partial
 * catalog). It only classifies one product at a time.
 *
 * Fatal conditions (LOCKED, Step 2F Gate 3):
 *   - missing/blank product name
 *   - invalid/non-numeric price
 *   - missing/invalid category (category, categoryLabel, or a
 *     non-finite categoryOrder)
 *   - malformed modifier group (missing id/name/selectionType, or a
 *     non-boolean `required`)
 *   - malformed modifier option, or a modifier group with zero options
 *     (Step 2F Gate 4: "Empty options: fatal")
 *   - invalid product identity (missing Firestore document ID)
 *
 * Explicitly NON-fatal (LOCKED, Step 2F Gate 3) — this module must
 * never reject a product for these:
 *   - missing itemOrder (caller defaults it, see catalogProjection.js)
 *   - duplicate ordering values across products
 *   - extra/legacy fields on the document, a group, or an option
 *   - absent imageUrl
 *   - absent modifierGroups
 */

class CatalogValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // stable, machine-readable — safe to report (never leaks internal data)
  }
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate one modifier option.
 * @returns {string[]} error codes, empty if valid
 */
function validateOption(option) {
  const errors = [];
  if (!option || typeof option !== "object") {
    errors.push("MALFORMED_MODIFIER_OPTION");
    return errors;
  }
  if (!isNonBlankString(option.id)) errors.push("MALFORMED_MODIFIER_OPTION");
  if (!isNonBlankString(option.name)) errors.push("MALFORMED_MODIFIER_OPTION");
  if (!isFiniteNumber(Number(option.price)) || Number(option.price) < 0) {
    errors.push("MALFORMED_MODIFIER_OPTION");
  }
  // isDefault is coerced to boolean by the projection step — its absence
  // or non-boolean value is not fatal by itself (matches existing app
  // tolerance for extra/legacy fields).
  return errors;
}

/**
 * Validate one modifier group (including all of its options).
 * @returns {string[]} error codes, empty if valid
 */
function validateModifierGroup(group) {
  const errors = [];
  if (!group || typeof group !== "object") {
    errors.push("MALFORMED_MODIFIER_GROUP");
    return errors;
  }
  if (!isNonBlankString(group.id)) errors.push("MALFORMED_MODIFIER_GROUP");
  if (!isNonBlankString(group.name)) errors.push("MALFORMED_MODIFIER_GROUP");
  if (!isNonBlankString(group.selectionType)) errors.push("MALFORMED_MODIFIER_GROUP");

  const options = Array.isArray(group.options) ? group.options : null;
  if (!options || options.length === 0) {
    // Step 2F Gate 4: "Empty options: fatal".
    errors.push("EMPTY_MODIFIER_OPTIONS");
  } else {
    for (const option of options) {
      errors.push(...validateOption(option));
    }
  }
  return errors;
}

/**
 * Validate one Product Master document for Catalog publishability.
 *
 * @param {object} productWithId - { id, ...rawFirestoreData }, the
 *   same shape `productsRepo.getProductById`/`listProducts` return.
 * @returns {{ ok: true } | { ok: false, productId: string|null, errors: string[] }}
 */
function validateProduct(productWithId) {
  const errors = [];

  const productId = productWithId && typeof productWithId.id === "string" ? productWithId.id : null;
  if (!isNonBlankString(productId)) {
    errors.push("INVALID_PRODUCT_IDENTITY");
  }

  const name = productWithId && productWithId.name;
  if (!isNonBlankString(name)) {
    errors.push("MISSING_PRODUCT_NAME");
  }

  const price = productWithId && Number(productWithId.price);
  if (!isFiniteNumber(price) || price <= 0) {
    errors.push("INVALID_PRICE");
  }

  const category = productWithId && productWithId.category;
  const categoryLabel = productWithId && productWithId.categoryLabel;
  const categoryOrder = productWithId && Number(productWithId.categoryOrder);
  if (!isNonBlankString(category) || !isNonBlankString(categoryLabel) || !isFiniteNumber(categoryOrder)) {
    errors.push("INVALID_CATEGORY");
  }

  const modifierGroups = productWithId && productWithId.modifierGroups;
  if (modifierGroups !== undefined && modifierGroups !== null) {
    if (!Array.isArray(modifierGroups)) {
      errors.push("MALFORMED_MODIFIER_GROUP");
    } else {
      for (const group of modifierGroups) {
        errors.push(...validateModifierGroup(group));
      }
    }
  }
  // Absent modifierGroups entirely is explicitly non-fatal (LOCKED).

  if (errors.length > 0) {
    return { ok: false, productId, errors };
  }
  return { ok: true };
}

module.exports = { CatalogValidationError, validateProduct };
