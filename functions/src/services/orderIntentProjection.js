/**
 * orderIntentProjection (services)
 *
 * Builds the customer-safe response shape for orderIntent — used for
 * both the "newly created" and "already existed / duplicate retry"
 * paths, so a client can't distinguish idempotent replay from a fresh
 * success (Scope 7 Section E / Scope 9's privacy design).
 *
 * NEVER included, by construction (these fields are never read from
 * the internal record in the first place, not merely omitted after
 * the fact): HPP/hppSnapshot, avgCost, reservationRequirement
 * (internal ingredient quantities), internal diagnostics, raw
 * Firestore errors, secrets.
 */

function buildOrderIntentSafeResponse(orderIntent) {
  return {
    orderState: orderIntent.orderState,
    authoritativeTotal: orderIntent.authoritativeTotal,
    items: (orderIntent.items || []).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      selectedModifiers: (item.selectedModifiers || []).map((m) => ({
        groupName: m.groupName,
        optionName: m.optionName,
        price: m.price,
      })),
    })),
    customerName: orderIntent.customerName || null,
    notes: orderIntent.notes || null,
  };
}

module.exports = { buildOrderIntentSafeResponse };
