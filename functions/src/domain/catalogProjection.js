/**
 * catalogProjection (domain)
 *
 * Pure business logic — no Firestore I/O, no external calls.
 *
 * Builds the customer-safe Catalog Product shape from a raw Product
 * Master document (Step 2F, LOCKED contract). Every field is built by
 * EXPLICIT construction — never by spreading the raw document — so a
 * field this contract does not name can never leak into the Catalog,
 * matching the existing precedent in
 * `functions/src/services/orderIntentProjection.js`.
 *
 * MUST be called only on a product that has already passed
 * `catalogValidation.validateProduct()` — this function does not
 * re-validate; it assumes the shape is already known-good.
 *
 * NEVER included, by construction (never read from the source document
 * in the first place): recipe, ingredientId, ingredientName, stock,
 * avgCost, HPP, cost, availability/sold-out, any internal field.
 *
 * Optional-field representation (Step 2F Gate 4, LOCKED): an absent
 * optional field is OMITTED entirely from the returned object — never
 * present as `null`, never present as an empty array/string.
 */

/**
 * @param {object} option - raw modifier option from Product Master
 * @returns {{id: string, name: string, price: number, isDefault: boolean}}
 */
function projectOption(option) {
  return {
    id: option.id,
    name: option.name,
    price: Number(option.price),
    isDefault: Boolean(option.isDefault),
  };
}

/**
 * @param {object} group - raw modifier group from Product Master
 * @returns {{id: string, name: string, selectionType: string, required: boolean, options: object[]}}
 */
function projectModifierGroup(group) {
  return {
    id: group.id,
    name: group.name,
    selectionType: group.selectionType,
    required: Boolean(group.required),
    // Array order is preserved as-stored (Step 2F Gate 4) — never sorted.
    options: group.options.map(projectOption),
  };
}

/**
 * @param {object} productWithId - { id, ...rawFirestoreData }, already
 *   validated by `catalogValidation.validateProduct()`.
 * @returns {object} the customer-safe Catalog Product.
 */
function projectProduct(productWithId) {
  const projected = {
    productId: productWithId.id,
    name: productWithId.name,
    category: productWithId.category,
    categoryLabel: productWithId.categoryLabel,
    categoryOrder: Number(productWithId.categoryOrder),
    // Missing itemOrder defaults to 99 — matches the existing Admin UI's
    // own fallback (aul-adm.html), explicitly non-fatal (LOCKED).
    itemOrder: productWithId.itemOrder != null ? Number(productWithId.itemOrder) : 99,
    price: Number(productWithId.price),
  };

  if (productWithId.imageUrl) {
    projected.imageUrl = productWithId.imageUrl;
  }

  if (Array.isArray(productWithId.modifierGroups) && productWithId.modifierGroups.length > 0) {
    projected.modifierGroups = productWithId.modifierGroups.map(projectModifierGroup);
  }
  // Empty/absent modifierGroups: key omitted entirely (LOCKED).

  return projected;
}

module.exports = { projectProduct };
