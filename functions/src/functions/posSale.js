/**
 * posSale
 *
 * SCOPE 23C — POS trusted sale boundary.
 *
 * Browser submits intent only.
 * Server determines authoritative price, recipe, HPP, stock effect,
 * payment validity, transaction identity, and historical snapshot.
 *
 * Final stock decrement + transaction creation happen in ONE
 * Firestore transaction.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const { requireAuth } = require("../services/authGuard");
const {
  validatePosSaleRequest,
  PosSaleValidationError,
} = require("../domain/posSale");
const { getProductById } = require("../repositories/productsRepo");
const {
  getTransaction,
  getTransactionInTransaction,
  createTransactionInTransaction,
} = require("../repositories/transactionsRepo");
const {
  getIngredientsByIdsInTransaction,
} = require("../repositories/ingredientsRepo");
const {
  resolveOrderLine,
  aggregateOrder,
  OrderValidationError,
} = require("../domain/pricingAndRecipe");
const { buildHppSnapshotForLine } = require("../domain/hppSnapshot");

const db = getFirestore();

function buildNoStruk(date) {
  const p = n => String(n).padStart(2, "0");

  return (
    `${p(date.getFullYear() % 100)}` +
    `${p(date.getMonth() + 1)}` +
    `${p(date.getDate())}` +
    `${p(date.getHours())}` +
    `${p(date.getMinutes())}` +
    `${p(date.getSeconds())}`
  );
}

function validatePayment(paymentMethod, cashReceived, authoritativeTotal) {
  if (paymentMethod !== "Cash") {
    throw new OrderValidationError(
      "PAYMENT_METHOD_NOT_SUPPORTED",
      "This payment method is not available in this sale boundary yet."
    );
  }

  if (
    typeof cashReceived !== "number" ||
    !Number.isFinite(cashReceived) ||
    cashReceived < authoritativeTotal
  ) {
    throw new OrderValidationError(
      "INSUFFICIENT_CASH",
      "Insufficient cash received."
    );
  }

  return {
    cashReceived,
    change: cashReceived - authoritativeTotal,
  };
}

function buildTransactionItems(resolvedLines, hppSnapshots) {
  return resolvedLines.map((line, index) => ({
    productId: line.productId,
    name: line.productName,
    qty: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    selectedModifiers: (line.resolvedModifiers || []).map(modifier => ({
      groupId: modifier.groupId,
      groupName: modifier.groupName,
      optionId: modifier.optionId,
      optionName: modifier.optionName,
      sellingPrice: modifier.price,
    })),
    hppSnapshot: hppSnapshots[index],
  }));
}

async function commitPosSale({
  idempotencyKey,
  ownerUid,
  resolvedLines,
  authoritativeTotal,
  paymentMethod,
  cashReceived,
  change,
  customerName,
  kasir,
}) {
  return db.runTransaction(async transaction => {
    // FIRST READ: authoritative idempotency guard.
    const existing = await getTransactionInTransaction(
      transaction,
      idempotencyKey
    );

    if (existing) {
      if (existing.ownerUid !== ownerUid) {
        throw new OrderValidationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This request could not be processed. Please try again with a new order."
        );
      }

      return {
        alreadyExisted: true,
        transaction: existing,
      };
    }

    const { reservationRequirement } = aggregateOrder(resolvedLines);

    const ingredientIds = reservationRequirement.map(
      requirement => requirement.ingredientId
    );

    const ingredientsById = await getIngredientsByIdsInTransaction(
      transaction,
      ingredientIds
    );

    // Validate every required ingredient before any stock write.
    for (const requirement of reservationRequirement) {
      const ingredient = ingredientsById.get(requirement.ingredientId);

      if (!ingredient) {
        throw new OrderValidationError(
          "INGREDIENT_UNAVAILABLE",
          "A required ingredient is not available."
        );
      }

      const stock = Number(ingredient.stock);

      if (!Number.isFinite(stock) || stock < requirement.qty) {
        throw new OrderValidationError(
          "INSUFFICIENT_STOCK",
          "Insufficient stock."
        );
      }
    }

    const hppSnapshots = resolvedLines.map(line =>
      buildHppSnapshotForLine(
        line.product,
        line,
        ingredientsById
      )
    );

    const now = new Date();

    const transactionData = {
      idempotencyKey,
      ownerUid,
      items: buildTransactionItems(resolvedLines, hppSnapshots),
      total: authoritativeTotal,
      paymentMethod,
      cashReceived,
      change,
      customerName,
      noStruk: buildNoStruk(now),
      kasir: typeof kasir === "string" ? kasir.trim() : "",
      source: "POS",
      status: "COMPLETED",
      createdAt: FieldValue.serverTimestamp(),
    };

    // All stock writes happen in the same transaction as the sale.
    for (const requirement of reservationRequirement) {
      const ingredientRef = db
        .collection("ingredients")
        .doc(requirement.ingredientId);

      transaction.update(ingredientRef, {
        stock: FieldValue.increment(-requirement.qty),
      });
    }

    createTransactionInTransaction(
      transaction,
      idempotencyKey,
      transactionData
    );

    return {
      alreadyExisted: false,
      transaction: transactionData,
    };
  });
}

const posSale = onCall(async request => {
  const invokedAt = new Date().toISOString();
  const ownerUid = requireAuth(request);

  let validated;

  try {
    validated = validatePosSaleRequest(request.data);
  } catch (err) {
    if (err instanceof PosSaleValidationError) {
      throw new HttpsError(
        "invalid-argument",
        err.message,
        { code: err.code }
      );
    }

    throw err;
  }

  const {
    idempotencyKey,
    items,
    paymentMethod,
    cashReceived,
    customerName,
    kasir,
  } = validated;

  logger.info("posSale: invoked", {
    functionId: "posSale",
    invokedAt,
    idempotencyKey,
    ownerUid,
    itemCount: items.length,
    paymentMethod,
  });

  try {
    // Replay pre-check.
    const existing = await getTransaction(idempotencyKey);

    if (existing) {
      if (existing.ownerUid !== ownerUid) {
        throw new OrderValidationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This request could not be processed. Please try again with a new order."
        );
      }

      return existing;
    }

    const resolvedLines = [];

    for (const item of items) {
      const product = await getProductById(item.productId);

      if (!product) {
        throw new OrderValidationError(
          "PRODUCT_UNAVAILABLE",
          "This product is not available."
        );
      }

      const resolved = resolveOrderLine(
        product,
        item.quantity,
        item.selectedModifiers
      );

      resolvedLines.push({
        product,
        productId: product.id,
        productName: product.name,
        ...resolved,
      });
    }

    const { authoritativeTotal } = aggregateOrder(resolvedLines);

    const payment = validatePayment(
      paymentMethod,
      cashReceived,
      authoritativeTotal
    );

    const result = await commitPosSale({
      idempotencyKey,
      ownerUid,
      resolvedLines,
      authoritativeTotal,
      paymentMethod,
      cashReceived: payment.cashReceived,
      change: payment.change,
      customerName,
      kasir,
    });

    logger.info("posSale: success", {
      functionId: "posSale",
      invokedAt,
      idempotencyKey,
      ownerUid,
      alreadyExisted: result.alreadyExisted,
    });

    return result.transaction;
  } catch (err) {
    if (err instanceof PosSaleValidationError) {
      logger.info("posSale: rejected", {
        functionId: "posSale",
        invokedAt,
        idempotencyKey,
        ownerUid,
        code: err.code,
      });

      throw new HttpsError(
        "invalid-argument",
        err.message,
        { code: err.code }
      );
    }

    if (err instanceof OrderValidationError) {
      logger.info("posSale: rejected", {
        functionId: "posSale",
        invokedAt,
        idempotencyKey,
        ownerUid,
        code: err.code,
      });

      throw new HttpsError(
        "failed-precondition",
        err.message,
        { code: err.code }
      );
    }

    logger.error("posSale: internal failure", {
      functionId: "posSale",
      invokedAt,
      idempotencyKey,
      ownerUid,
      errorMessage: err?.message || "unknown error",
    });

    throw new HttpsError(
      "internal",
      "We couldn't process that sale right now. Please try again."
    );
  }
});

module.exports = { posSale };
