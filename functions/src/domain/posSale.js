/**
 * posSale
 *
 * SCOPE 23C — POS checkout trusted business boundary.
 *
 * Responsibility:
 * - validate POS sale inputs
 * - prepare authoritative sale data
 * - provide the atomic sale transaction boundary
 *
 * IMPORTANT:
 * - Client price, total, HPP, recipe, stock, transaction identity
 *   are never trusted as authoritative.
 * - Firestore writes must remain atomic.
 * - This module must not call external APIs.
 */

class PosSaleValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PosSaleValidationError";
    this.code = code;
    this.details = details;
  }
}

function validatePosSaleRequest(input) {
  if (!input || typeof input !== "object") {
    throw new PosSaleValidationError(
      "INVALID_REQUEST",
      "The sale request is invalid."
    );
  }

  const {
    idempotencyKey,
    items,
    paymentMethod,
    cashReceived,
    customerName,
  } = input;

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0
  ) {
    throw new PosSaleValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "A valid idempotency key is required."
    );
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new PosSaleValidationError(
      "INVALID_ITEMS",
      "At least one sale item is required."
    );
  }

  if (typeof paymentMethod !== "string" || paymentMethod.trim() === "") {
    throw new PosSaleValidationError(
      "INVALID_PAYMENT_METHOD",
      "A valid payment method is required."
    );
  }

  if (
    cashReceived !== null &&
    cashReceived !== undefined &&
    (!Number.isFinite(Number(cashReceived)) || Number(cashReceived) < 0)
  ) {
    throw new PosSaleValidationError(
      "INVALID_CASH_RECEIVED",
      "Cash received is invalid."
    );
  }

  return {
    idempotencyKey: idempotencyKey.trim(),
    items,
    paymentMethod: paymentMethod.trim(),
    cashReceived:
      cashReceived === null || cashReceived === undefined
        ? null
        : Number(cashReceived),
    customerName:
      typeof customerName === "string" ? customerName.trim() : "",
  };
}

module.exports = {
  PosSaleValidationError,
  validatePosSaleRequest,
};
