/**
 * transactionsRepo
 *
 * SCOPE 23C — POS trusted sale repository.
 *
 * This module is data access only.
 * It does NOT calculate price, HPP, stock, payment, or business rules.
 *
 * Transaction identity is the idempotency key:
 *   transactions/{idempotencyKey}
 *
 * The authoritative atomic write is performed by the POS sale
 * domain boundary, using these repository helpers inside the
 * same Firestore transaction as stock decrements.
 */

const { getFirestore } = require("firebase-admin/firestore");

const db = getFirestore();

function transactionRef(idempotencyKey) {
  return db.collection("transactions").doc(idempotencyKey);
}

async function getTransaction(idempotencyKey) {
  const snapshot = await transactionRef(idempotencyKey).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function getTransactionInTransaction(transaction, idempotencyKey) {
  const snapshot = await transaction.get(transactionRef(idempotencyKey));
  return snapshot.exists ? snapshot.data() : null;
}

function createTransactionInTransaction(transaction, idempotencyKey, transactionData) {
  transaction.create(
    transactionRef(idempotencyKey),
    transactionData
  );
}

module.exports = {
  transactionRef,
  getTransaction,
  getTransactionInTransaction,
  createTransactionInTransaction,
};
