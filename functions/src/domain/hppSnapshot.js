/**
 * hppSnapshot (domain)
 *
 * SCOPE 23C — authoritative Historical Financial Integrity snapshot.
 *
 * Pure business logic. Ingredient documents must already have been
 * read by the trusted transaction boundary.
 *
 * Rules:
 * - avgCost is the authoritative ingredient cost at checkout time.
 * - base recipe + selected modifier recipes are included.
 * - no row-level rounding.
 * - Math.ceil() is applied exactly once to total HPP per unit.
 * - the returned snapshot is a frozen historical value and must be
 *   written into the transaction record unchanged.
 */

const { OrderValidationError } = require("./pricingAndRecipe");

function getIngredientCost(ingredientsById, ingredientId) {
  const ingredient = ingredientsById.get(ingredientId);

  if (!ingredient) {
    throw new OrderValidationError(
      "INGREDIENT_UNAVAILABLE",
      `Ingredient ${ingredientId} is not available.`
    );
  }

  const avgCost = Number(ingredient.avgCost);
  if (!Number.isFinite(avgCost) || avgCost < 0) {
    throw new OrderValidationError(
      "INGREDIENT_COST_INVALID",
      `Ingredient ${ingredientId} has an invalid cost.`
    );
  }

  return { ingredient, avgCost };
}

function buildRecipeSnapshot(recipeRows, ingredientsById) {
  const snapshot = [];
  let subtotal = 0;

  for (const row of recipeRows || []) {
    if (!row || !row.ingredientId) {
      throw new OrderValidationError(
        "RECIPE_INVALID",
        "A sale item contains an invalid recipe entry."
      );
    }

    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new OrderValidationError(
        "RECIPE_INVALID",
        "A sale item contains an invalid recipe quantity."
      );
    }

    const { ingredient, avgCost } = getIngredientCost(
      ingredientsById,
      row.ingredientId
    );

    const rowSubtotal = qty * avgCost;

    snapshot.push({
      ingredientId: row.ingredientId,
      ingredientName: ingredient.name,
      qty,
      costAtTransaction: avgCost,
      subtotal: rowSubtotal,
    });

    subtotal += rowSubtotal;
  }

  return { snapshot, subtotal };
}

function buildHppSnapshotForLine(product, resolvedLine, ingredientsById) {
  const baseResult = buildRecipeSnapshot(
    product.recipe || [],
    ingredientsById
  );

  const modifierDetail = [];
  let modifierHppPerUnit = 0;

  for (const modifier of resolvedLine.resolvedModifiers || []) {
    const recipeResult = buildRecipeSnapshot(
      modifier.recipe || [],
      ingredientsById
    );

    modifierDetail.push({
      groupId: modifier.groupId,
      groupName: modifier.groupName,
      optionId: modifier.optionId,
      optionName: modifier.optionName,
      sellingPrice: modifier.price,
      hpp: recipeResult.subtotal,
      recipe: recipeResult.snapshot,
    });

    modifierHppPerUnit += recipeResult.subtotal;
  }

  const baseHppPerUnit = baseResult.subtotal;
  const totalHppPerUnit = Math.ceil(
    baseHppPerUnit + modifierHppPerUnit
  );

  const itemTotalHpp =
    totalHppPerUnit * resolvedLine.quantity;

  return {
    baseHppPerUnit,
    modifierHppPerUnit,
    totalHppPerUnit,
    itemTotalHpp,
    baseRecipe: baseResult.snapshot,
    modifierDetail,
  };
}

module.exports = {
  buildHppSnapshotForLine,
};
