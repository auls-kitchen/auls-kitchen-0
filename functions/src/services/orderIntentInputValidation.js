/**
 * orderIntentInputValidation (services)
 *
 * Validates the SHAPE of an orderIntent request. This is deliberately
 * separate from business validation (product existence, stock, etc.)
 * — this module only checks that the client sent well-formed data of
 * the right types, per the locked contract (Scope 1):
 *
 * Client MAY provide: idempotencyKey, items[] (each: productId,
 * quantity, selectedModifiers[]), customerName, notes.
 *
 * Client must NEVER be trusted for: price, total, recipe, HPP, stock,
 * orderState, or any other authoritative value — if any such field is
 * present in the request, it is silently ignored, never read by any
 * downstream code (not merely rejected — genuinely never consulted).
 */

const { HttpsError } = require("firebase-functions/v2/https");

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9-_]{8,128}$/;

function validateOrderIntentRequest(data) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Request body is required.");
  }

  const { idempotencyKey, items, customerName, notes } = data;

  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid idempotencyKey is required."
    );
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError("invalid-argument", "At least one order line is required.");
  }

  const validatedItems = items.map((item, idx) => {
    if (!item || typeof item.productId !== "string" || !item.productId.trim()) {
      throw new HttpsError("invalid-argument", `Item ${idx}: productId is required.`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new HttpsError("invalid-argument", `Item ${idx}: quantity must be a positive whole number.`);
    }

    let selectedModifiers = [];
    if (item.selectedModifiers !== undefined) {
      if (!Array.isArray(item.selectedModifiers)) {
        throw new HttpsError("invalid-argument", `Item ${idx}: selectedModifiers must be an array.`);
      }
      selectedModifiers = item.selectedModifiers.map((m, mIdx) => {
        if (!m || typeof m.groupId !== "string" || typeof m.optionId !== "string") {
          throw new HttpsError(
            "invalid-argument",
            `Item ${idx}, modifier ${mIdx}: groupId and optionId are required.`
          );
        }
        // Deliberately extract ONLY groupId/optionId — any other field
        // the client sent here (e.g. a forged price) is never copied
        // forward into validatedItems at all.
        return { groupId: m.groupId, optionId: m.optionId };
      });
    }

    // Deliberately extract ONLY productId/quantity/selectedModifiers —
    // a forged item.price, item.recipe, item.hpp, etc. is never
    // copied forward.
    return { productId: item.productId, quantity: item.quantity, selectedModifiers };
  });

  const validatedCustomerName =
    typeof customerName === "string" ? customerName.trim().slice(0, 200) : null;
  const validatedNotes = typeof notes === "string" ? notes.trim().slice(0, 500) : null;

  return {
    idempotencyKey,
    items: validatedItems,
    customerName: validatedCustomerName,
    notes: validatedNotes,
  };
}

module.exports = { validateOrderIntentRequest };
