/**
 * reservation (domain)
 *
 * THE atomic core of orderIntent (Scope 7, Scope 14A Refinement A).
 *
 * This is the ONLY place in the codebase allowed to:
 *   - decrement `ingredients.stock` for a Kiosk reservation
 *   - create an `orderIntents` document
 * and it does both inside ONE Firestore transaction, alongside the
 * idempotency existence check, so all three actions are one atomic
 * unit — never partially applied.
 *
 * HARD RULE (Scope 5/11/14A, non-negotiable): this function and
 * everything it calls MUST NEVER perform an external API call. It
 * only reads/writes Firestore via the transaction object.
 *
 * SCOPE 24 FIX: the idempotency-duplicate-return path now verifies
 * ownerUid matches before returning an existing Order Intent's data —
 * this closes a real ownership gap found during Scope 24's static
 * audit (a stolen/reused idempotencyKey could previously return
 * another customer's order details). See inline comment below.
 */

const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getIngredientsByIdsInTransaction } = require("../repositories/ingredientsRepo");
const {
  getOrderIntentInTransaction,
  createOrderIntentInTransaction,
} = require("../repositories/orderIntentsRepo");
const { OrderValidationError } = require("./pricingAndRecipe");

/**
 * Attempt to reserve stock and create the Order Intent, atomically.
 *
 * @param {object} params
 * @param {string} params.idempotencyKey
 * @param {string} params.ownerUid
 * @param {Array} params.resolvedLines - output of resolveOrderLine() per line
 * @param {number} params.authoritativeTotal
 * @param {Array} params.reservationRequirement - aggregated {ingredientId, ingredientName, qty}[]
 * @param {string} [params.customerName]
 * @param {string} [params.notes]
 *
 * @returns {Promise<{ alreadyExisted: boolean, orderIntent: object }>}
 *   alreadyExisted = true means this was a duplicate/retry — no new
 *   reservation was performed, the existing state was simply returned
 *   (Scope 7 Section E / Scope 14A Refinement A).
 *
 * @throws {OrderValidationError} with code "INSUFFICIENT_STOCK" if
 *   any required ingredient lacks sufficient stock. In that case, NO
 *   Firestore write occurs at all (Scope 7 Section C — all-or-nothing).
 */
async function reserveOrderIntent(params) {
  const {
    idempotencyKey,
    ownerUid,
    resolvedLines,
    authoritativeTotal,
    reservationRequirement,
    customerName,
    notes,
  } = params;

  const db = getFirestore();

  const result = await db.runTransaction(async (transaction) => {
    // --- Step 1: idempotency check, INSIDE the transaction, first. ---
    // This must happen before any read/write of ingredient stock, so a
    // concurrent retry with the same key can never race past this
    // point (Scope 14A Refinement A — this is the whole point of
    // moving the check inside the transaction rather than checking
    // separately beforehand).
    const existing = await getOrderIntentInTransaction(transaction, idempotencyKey);
    if (existing) {
      // SCOPE 24 FIX: an idempotencyKey collision belonging to a
      // DIFFERENT owner must never be treated as "my own retry" and
      // must never return that order's data. Per Scope 10 Section G's
      // ownership-vs-idempotency distinction: idempotencyKey answers
      // "same attempt?", NOT "is this caller authorized?" — those are
      // two independent checks, and this one was previously missing.
      //
      // Per Scope 10's anti-enumeration principle, the rejection is
      // generic and does not confirm to the caller that the key
      // belongs to someone else — full detail is logged internally
      // by the caller (orderIntent.js), never returned to the client.
      if (existing.ownerUid !== ownerUid) {
        const err = new OrderValidationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This request could not be processed. Please try again with a new order."
        );
        throw err;
      }
      return { alreadyExisted: true, orderIntent: existing };
    }

    // --- Step 2: read every required ingredient, within the transaction. ---
    const ingredientIds = reservationRequirement.map((r) => r.ingredientId);
    const ingredientsById = await getIngredientsByIdsInTransaction(transaction, ingredientIds);

    // --- Step 3: verify ALL required stock BEFORE any decrement. ---
    // All-or-nothing (Scope 7 Section C): a single insufficient
    // ingredient rejects the entire reservation, no partial writes.
    const insufficient = [];
    for (const req of reservationRequirement) {
      const ing = ingredientsById.get(req.ingredientId);
      const currentStock = ing ? Number(ing.stock) || 0 : 0;
      if (!ing || currentStock < req.qty) {
        insufficient.push({
          ingredientId: req.ingredientId,
          ingredientName: req.ingredientName,
          required: req.qty,
          available: currentStock,
        });
      }
    }

    if (insufficient.length > 0) {
      // No writes have occurred. Throwing here aborts the transaction
      // cleanly — Firestore performs no writes for an aborted
      // transaction, satisfying "no ingredient is decremented, no
      // Order Intent is created" (Scope 8/14A Section 8).
      const err = new OrderValidationError(
        "INSUFFICIENT_STOCK",
        "One or more required ingredients are insufficient."
      );
      err.details = insufficient;
      throw err;
    }

    // --- Step 4: decrement every required ingredient (all, atomically). ---
    for (const req of reservationRequirement) {
      const ref = db.collection("ingredients").doc(req.ingredientId);
      transaction.update(ref, {
        stock: FieldValue.increment(-req.qty),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // --- Step 5: create the Order Intent, in the SAME transaction. ---
    const items = resolvedLines.map((line, idx) => ({
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      selectedModifiers: line.resolvedModifiers.map((m) => ({
        groupId: m.groupId,
        groupName: m.groupName,
        optionId: m.optionId,
        optionName: m.optionName,
        price: m.price,
      })),
    }));

    const orderIntentData = {
      ownerUid,
      orderState: "VALIDATED",
      items,
      authoritativeTotal,
      reservationRequirement, // frozen aggregated ingredient map (Scope 6/7)
      customerName: customerName || null,
      notes: notes || null,
    };

    createOrderIntentInTransaction(transaction, idempotencyKey, orderIntentData);

    return {
      alreadyExisted: false,
      orderIntent: { id: idempotencyKey, ...orderIntentData },
    };
  });

  return result;
}

module.exports = { reserveOrderIntent };
