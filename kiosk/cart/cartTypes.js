"use strict";

/**
 * Cart Core - data contracts and pure identity/normalization helpers.
 *
 * Everything here is non-authoritative. Nothing in this module computes
 * price, recipe, HPP, stock, or any other business truth - that remains
 * the backend's (OrderIntent's) responsibility, per the locked Kiosk
 * Cart architecture (STEP 51/52/53). This module has no Firebase, no
 * OrderIntent, no browser storage, and no AUL World dependency.
 *
 * @typedef {Object} SelectedModifier
 * @property {string} groupId
 * @property {string} optionId
 *
 * @typedef {Object} DisplaySnapshot
 * Non-authoritative, presentation-only cache. Never trusted as price or
 * recipe truth by the reducer or by anything downstream of it.
 * @property {string} [name]
 * @property {number} [price]
 * @property {string} [imageUrl]
 * @property {string} [categoryLabel]
 *
 * @typedef {Object} CartLine
 * @property {string} localLineId - UI-only identity. Never sent to backend.
 * @property {string} productId
 * @property {number} quantity - positive integer
 * @property {SelectedModifier[]} selectedModifiers - normalized (sorted, deduped)
 * @property {DisplaySnapshot} displaySnapshot - non-authoritative
 *
 * @typedef {Object} CartDraft
 * @property {CartLine[]} lines
 * @property {string|null} customerName
 * @property {string|null} notes
 */

function createEmptyCartDraft() {
  return Object.freeze({
    lines: Object.freeze([]),
    customerName: null,
    notes: null,
  });
}

let _localLineIdCounter = 0;

/**
 * Generates a localLineId. Purely a UI list-rendering convenience - not a
 * product identity, not an OrderIntent identity, not an idempotency key.
 * Never sent to the backend, not required to survive beyond the Cart's
 * own lifecycle.
 */
function generateLocalLineId() {
  _localLineIdCounter += 1;
  return (
    "line_" +
    Date.now().toString(36) +
    "_" +
    _localLineIdCounter.toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates and normalizes a selectedModifiers input into a deterministic,
 * order-independent form: exact-duplicate {groupId,optionId} pairs are
 * removed (hygiene only), and the result is sorted by (groupId, optionId).
 *
 * Returns null if the input is not a well-formed selectedModifiers array -
 * Cart Core refuses to guess at malformed modifier selection, since that
 * is meaningful customer intent, not a hygiene concern.
 *
 * An empty array (or undefined) is valid: a product with no modifiers
 * selected.
 *
 * Never uses modifier name, price, recipe, or display snapshot as identity
 * - only groupId + optionId, matching the actual backend/product schema.
 *
 * @param {unknown} selectedModifiers
 * @returns {SelectedModifier[]|null}
 */
function normalizeSelectedModifiers(selectedModifiers) {
  if (selectedModifiers === undefined) return [];
  if (!Array.isArray(selectedModifiers)) return null;

  const seen = new Set();
  const normalized = [];

  for (const entry of selectedModifiers) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !isNonEmptyString(entry.groupId) ||
      !isNonEmptyString(entry.optionId)
    ) {
      return null; // malformed entry - refuse to guess
    }
    const key = entry.groupId + ":" + entry.optionId;
    if (seen.has(key)) continue; // exact-duplicate pair: dedupe (hygiene only)
    seen.add(key);
    normalized.push({ groupId: entry.groupId, optionId: entry.optionId });
  }

  normalized.sort((a, b) => {
    if (a.groupId !== b.groupId) return a.groupId < b.groupId ? -1 : 1;
    if (a.optionId !== b.optionId) return a.optionId < b.optionId ? -1 : 1;
    return 0;
  });

  return normalized;
}

/**
 * Deterministic identity key for "logical line equivalence": same
 * productId + same selected modifier set (order-independent) => same key.
 *
 * @param {string} productId
 * @param {SelectedModifier[]} normalizedSelectedModifiers - already normalized
 * @returns {string}
 */
function computeLineKey(productId, normalizedSelectedModifiers) {
  const modifierPart = normalizedSelectedModifiers
    .map(function (m) {
      return m.groupId + ":" + m.optionId;
    })
    .join("|");
  return productId + "::" + modifierPart;
}

module.exports = {
  createEmptyCartDraft,
  generateLocalLineId,
  isPositiveInteger,
  isNonEmptyString,
  normalizeSelectedModifiers,
  computeLineKey,
};
