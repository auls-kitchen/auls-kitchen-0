/**
 * orderIntentsRepo
 *
 * Access to the `orderIntents` collection.
 *
 * NOTE: `orderIntents` is a NEW conceptual collection proposed in
 * Scope 3 and refined in Scopes 6/7/10/14A. It does not exist yet in
 * production Firestore. This repository does not "create" the
 * collection in any special sense — Firestore collections come into
 * existence implicitly on first document write, exactly like every
 * existing collection in this project (products, ingredients, etc.)
 * originally did. No schema/collection is being manually provisioned
 * here; this is ordinary application code.
 *
 * Document shape (per Scope 3/6/7/10/14A, PROPOSED — first real
 * implementation of it):
 *
 * orderIntents/{idempotencyKey} = {
 *   idempotencyKey,
 *   ownerUid,                      // Scope 10 — Anonymous Auth UID that created this order
 *   orderState,                    // "VALIDATED" | "REJECTED" | ... (Scope 2)
 *   items: [{
 *     productId, productName, quantity,
 *     unitPrice,                   // authoritative, server-resolved
 *     selectedModifiers: [{ groupId, groupName, optionId, optionName, price }],
 *     lineTotal,
 *   }],
 *   authoritativeTotal,            // frozen, server-computed (Scope 6)
 *   reservationRequirement: [{ ingredientId, ingredientName, qty }], // frozen aggregated map (Scope 6/7)
 *   customerName, notes,           // client-provided, non-authoritative (Scope 1)
 *   rejectionReason,               // only if orderState === "REJECTED"
 *   createdAt, updatedAt,          // server timestamps
 * }
 */

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function orderIntentRef(idempotencyKey) {
  const db = getFirestore();
  return db.collection("orderIntents").doc(idempotencyKey);
}

/**
 * Read an existing Order Intent WITHIN a transaction (so the
 * idempotency check participates in the same atomic unit as the
 * reservation decision — Scope 14A Refinement A).
 *
 * Returns { id, ...data } | null.
 */
async function getOrderIntentInTransaction(transaction, idempotencyKey) {
  const ref = orderIntentRef(idempotencyKey);
  const snap = await transaction.get(ref);
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Write a new Order Intent WITHIN a transaction, as part of the same
 * atomic unit as the ingredient stock decrements.
 */
function createOrderIntentInTransaction(transaction, idempotencyKey, data) {
  const ref = orderIntentRef(idempotencyKey);
  transaction.set(ref, {
    ...data,
    idempotencyKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

module.exports = {
  orderIntentRef,
  getOrderIntentInTransaction,
  createOrderIntentInTransaction,
};
