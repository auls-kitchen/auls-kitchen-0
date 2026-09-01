/**
 * ingredientsRepo
 *
 * Read access to the existing `ingredients` collection, for use
 * OUTSIDE the reservation transaction (e.g., nothing in this module
 * performs writes — the atomic decrement itself lives inside
 * domain/reservation.js's transaction body, per Scope 14A's
 * dependency direction: transaction logic owns its own reads/writes
 * so the whole check-then-write stays inside one atomic unit).
 *
 * Schema (VERIFIED against aul-adm.html ingredient save handler,
 * re-checked directly for Scope 22):
 *
 * ingredients/{id} = {
 *   name, unit, stock, avgCost, minStock, createdAt, updatedAt
 * }
 */

const { getFirestore } = require("firebase-admin/firestore");

/**
 * Fetch multiple ingredient documents by ID, within an existing
 * Firestore transaction (so the reads participate in the same
 * atomic unit as the later stock check/decrement).
 *
 * Returns a Map<ingredientId, { id, ...data } | null>.
 */
async function getIngredientsByIdsInTransaction(transaction, ingredientIds) {
  const db = getFirestore();
  const result = new Map();

  // Firestore transactions require reads before writes, and reads
  // must go through the transaction object itself, not a bare get().
  for (const id of ingredientIds) {
    const ref = db.collection("ingredients").doc(id);
    const snap = await transaction.get(ref);
    result.set(id, snap.exists ? { id: snap.id, ...snap.data() } : null);
  }

  return result;
}

module.exports = { getIngredientsByIdsInTransaction };
