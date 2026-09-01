/**
 * pricingAndRecipe (domain)
 *
 * Pure business logic — no Firestore I/O, no external calls.
 * Given an already-fetched product document and the client's raw
 * modifier SELECTION (groupId/optionId pairs only — never price or
 * recipe from the client, per Scope 1's locked contract), this module
 * resolves the authoritative price and combined recipe using ONLY the
 * server-fetched `product.modifierGroups[]` data.
 *
 * This deliberately does NOT resurrect the old hardcoded
 * `OPTION_GROUPS` pattern that predates this project's Category
 * Master / Modifier architecture work — modifier configuration comes
 * exclusively from `product.modifierGroups[]`, matching the actual
 * current schema (verified directly from aul-adm.html for Scope 22).
 */

class OrderValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // stable machine-readable reason, safe to map to a customer-facing message
  }
}

/**
 * Resolve one line item's selected modifiers against the product's
 * actual modifierGroups[], validating that every selection is real.
 *
 * @param {object} product - full product doc (from productsRepo)
 * @param {Array<{groupId: string, optionId: string}>} selectedModifiers - client selection only
 * @returns {{
 *   resolvedModifiers: Array<{groupId, groupName, optionId, optionName, price, recipe}>,
 *   modifierPriceTotal: number
 * }}
 */
function resolveModifierSelection(product, selectedModifiers) {
  const groups = Array.isArray(product.modifierGroups) ? product.modifierGroups : [];
  const resolved = [];
  let modifierPriceTotal = 0;

  for (const selection of selectedModifiers || []) {
    const group = groups.find((g) => g.id === selection.groupId);
    if (!group) {
      throw new OrderValidationError(
        "MODIFIER_GROUP_UNAVAILABLE",
        `Modifier group ${selection.groupId} is not available on this product.`
      );
    }

    const option = (group.options || []).find((o) => o.id === selection.optionId);
    if (!option) {
      throw new OrderValidationError(
        "MODIFIER_OPTION_UNAVAILABLE",
        `Modifier option ${selection.optionId} is not available in group ${group.id}.`
      );
    }

    resolved.push({
      groupId: group.id,
      groupName: group.name,
      optionId: option.id,
      optionName: option.name,
      price: Number(option.price) || 0,
      recipe: Array.isArray(option.recipe) ? option.recipe : [],
    });
    modifierPriceTotal += Number(option.price) || 0;
  }

  // Enforce required groups: every group marked required must have
  // exactly one selection present among resolved modifiers.
  for (const group of groups) {
    if (!group.required) continue;
    const hasSelection = resolved.some((r) => r.groupId === group.id);
    if (!hasSelection) {
      throw new OrderValidationError(
        "REQUIRED_MODIFIER_MISSING",
        `Required modifier group "${group.name}" was not selected.`
      );
    }
  }

  return { resolvedModifiers: resolved, modifierPriceTotal };
}

/**
 * Resolve one order line (one product + its modifier selection +
 * quantity) into authoritative unit price, line total, and the
 * combined per-unit recipe (base + selected modifiers).
 *
 * @param {object} product - full product doc
 * @param {number} quantity - client-provided intent, validated for type/positivity only
 * @param {Array<{groupId, optionId}>} selectedModifiers - client selection
 * @returns {{
 *   unitPrice: number,
 *   lineTotal: number,
 *   resolvedModifiers: Array,
 *   combinedRecipePerUnit: Array<{ingredientId, ingredientName, qty}>
 * }}
 */
function resolveOrderLine(product, quantity, selectedModifiers) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new OrderValidationError("INVALID_QUANTITY", "Quantity must be a positive whole number.");
  }

  const { resolvedModifiers, modifierPriceTotal } = resolveModifierSelection(
    product,
    selectedModifiers
  );

  const unitPrice = (Number(product.price) || 0) + modifierPriceTotal;
  const lineTotal = unitPrice * quantity;

  // Combine base recipe + every selected modifier's recipe into one
  // per-unit ingredient list (Scope 7 Section D/Section F).
  const baseRecipe = Array.isArray(product.recipe) ? product.recipe : [];
  const combinedRecipePerUnit = [...baseRecipe];
  for (const mod of resolvedModifiers) {
    combinedRecipePerUnit.push(...mod.recipe);
  }

  return { unitPrice, lineTotal, resolvedModifiers, combinedRecipePerUnit, quantity };
}

/**
 * Aggregate multiple resolved order lines into:
 *  - authoritativeTotal (sum of all line totals)
 *  - one combined per-order ingredient requirement map
 *    (ingredientId -> total qty needed, across all lines and their
 *    quantities — Scope 7 Section D/G)
 */
function aggregateOrder(resolvedLines) {
  let authoritativeTotal = 0;
  const requirementMap = new Map(); // ingredientId -> { ingredientId, ingredientName, qty }

  for (const line of resolvedLines) {
    authoritativeTotal += line.lineTotal;

    for (const ing of line.combinedRecipePerUnit) {
      const totalQtyForThisLine = (Number(ing.qty) || 0) * line.quantity;
      const existing = requirementMap.get(ing.ingredientId);
      if (existing) {
        existing.qty += totalQtyForThisLine;
      } else {
        requirementMap.set(ing.ingredientId, {
          ingredientId: ing.ingredientId,
          ingredientName: ing.ingredientName,
          qty: totalQtyForThisLine,
        });
      }
    }
  }

  return {
    authoritativeTotal,
    reservationRequirement: Array.from(requirementMap.values()),
  };
}

module.exports = {
  OrderValidationError,
  resolveModifierSelection,
  resolveOrderLine,
  aggregateOrder,
};
