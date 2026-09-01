/**
 * productsRepo
 *
 * Read-only access to the existing `products` collection.
 *
 * Schema (VERIFIED against aul-adm.html product save handler,
 * re-checked directly for Scope 22 — not assumed from memory):
 *
 * products/{id} = {
 *   name, price, category, categoryLabel, categoryOrder, itemOrder,
 *   recipe: [{ ingredientId, ingredientName, qty }],
 *   modifierGroups: [{
 *     id, name, selectionType, required,
 *     options: [{
 *       id, name, price, isDefault,
 *       recipe: [{ ingredientId, ingredientName, qty }]
 *     }]
 *   }],
 *   imageUrl? (optional)
 * }
 *
 * This module performs ONLY reads. It must never write to `products`.
 */

const { getFirestore } = require("firebase-admin/firestore");

/**
 * Fetch a single product document by ID.
 * Returns null if it does not exist (caller decides how to handle
 * "product unavailable" — this repository does not throw domain
 * errors itself).
 */
async function getProductById(productId) {
  const db = getFirestore();
  const snap = await db.collection("products").doc(productId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

module.exports = { getProductById };
