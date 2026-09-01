/**
 * orderIntent
 *
 * SCOPE 22 — first business-logic trusted function for AUL's Kitchen.
 *
 * Trusted flow (Scope 11/14A, unchanged):
 *
 *   authenticate
 *   -> validate request shape
 *   -> resolve product/modifiers (server reads, outside the transaction)
 *   -> compute authoritative price per line
 *   -> aggregate recipe (base + modifiers) into a combined per-order map
 *   -> Firestore transaction:
 *        - re-check orderIntents/{idempotencyKey} (idempotency, FIRST)
 *        - if exists: return existing state, no further writes
 *        - read all required ingredients
 *        - verify ALL stock before ANY decrement (all-or-nothing)
 *        - decrement all required ingredients
 *        - create the frozen Order Intent
 *   -> return customer-safe projection only
 *
 * NOT implemented in this scope, deliberately (per Scope 22's hard
 * limit): payment, webhook, orderStatus, reservationExpiry, Rules,
 * App Check, deployment, billing.
 *
 * NEVER accepted as authoritative from the client, anywhere in this
 * file or anything it calls: price, total, recipe, HPP, stock,
 * orderState. These are always server-resolved from Firestore.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");

const { requireAuth } = require("../services/authGuard");
const { validateOrderIntentRequest } = require("../services/orderIntentInputValidation");
const { buildOrderIntentSafeResponse } = require("../services/orderIntentProjection");
const { getProductById } = require("../repositories/productsRepo");
const { resolveOrderLine, aggregateOrder, OrderValidationError } = require("../domain/pricingAndRecipe");
const { reserveOrderIntent } = require("../domain/reservation");

const orderIntent = onCall(async (request) => {
  const invokedAt = new Date().toISOString();

  // --- Step 1: authenticate. Reject immediately if missing. ---
  const ownerUid = requireAuth(request);

  // --- Step 2: validate request shape (not business validity yet). ---
  const validated = validateOrderIntentRequest(request.data);
  const { idempotencyKey, items, customerName, notes } = validated;

  logger.info("orderIntent: invoked", {
    functionId: "orderIntent",
    invokedAt,
    idempotencyKey,
    ownerUid,
    itemCount: items.length,
  });

  try {
    // --- Step 3: resolve product/modifiers, OUTSIDE the transaction. ---
    // These are plain master-data reads (product currently exists and
    // what it currently costs) — the reservation decision itself
    // happens later, inside the transaction, where stock is actually
    // checked/decremented.
    const resolvedLines = [];
    for (const item of items) {
      const product = await getProductById(item.productId);
      if (!product) {
        throw new OrderValidationError(
          "PRODUCT_UNAVAILABLE",
          `Product ${item.productId} is not available.`
        );
      }

      const resolved = resolveOrderLine(product, item.quantity, item.selectedModifiers);
      resolvedLines.push({
        productId: product.id,
        productName: product.name,
        ...resolved,
      });
    }

    // --- Step 4: aggregate authoritative total + combined ingredient map. ---
    const { authoritativeTotal, reservationRequirement } = aggregateOrder(resolvedLines);

    // --- Step 5: atomic reservation transaction (idempotency + stock + write, one unit). ---
    const { alreadyExisted, orderIntent: resultOrderIntent } = await reserveOrderIntent({
      idempotencyKey,
      ownerUid,
      resolvedLines,
      authoritativeTotal,
      reservationRequirement,
      customerName,
      notes,
    });

    logger.info("orderIntent: success", {
      functionId: "orderIntent",
      invokedAt,
      idempotencyKey,
      ownerUid,
      alreadyExisted,
    });

    // --- Step 6: return customer-safe projection only. ---
    return buildOrderIntentSafeResponse(resultOrderIntent);
  } catch (err) {
    if (err instanceof OrderValidationError) {
      // Known, safe-to-communicate business rejection (product
      // unavailable, insufficient stock, invalid modifier selection,
      // etc.). Customer-facing message stays generic/categorical —
      // internal detail (e.g. exact stock numbers) is logged, not
      // returned to the client.
      logger.info("orderIntent: rejected", {
        functionId: "orderIntent",
        invokedAt,
        idempotencyKey,
        ownerUid,
        code: err.code,
        details: err.details || null,
      });

      throw new HttpsError("failed-precondition", err.message, { code: err.code });
    }

    // Unexpected/internal failure. Full detail stays server-side only.
    logger.error("orderIntent: internal failure", {
      functionId: "orderIntent",
      invokedAt,
      idempotencyKey,
      ownerUid,
      errorMessage: err && err.message ? err.message : "unknown error",
    });

    throw new HttpsError(
      "internal",
      "We couldn't process that order right now. Please try again."
    );
  }
});

module.exports = { orderIntent };
