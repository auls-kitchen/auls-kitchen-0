/**
 * catalogCanonicalization (domain)
 *
 * Pure business logic — no Firestore I/O, no external calls.
 *
 * Produces the deterministic canonical byte representation of a
 * projected Catalog Product array, per Step 2F Gate 4 (LOCKED):
 *
 *   1. Product order: categoryOrder -> itemOrder -> productId tie-break.
 *   2. Modifier group array order: preserved as-projected (never sorted).
 *   3. Modifier option array order: preserved as-projected (never sorted).
 *   4. Object keys: recursively alphabetized before serialization.
 *   5. `undefined` values: omitted entirely (never serialized).
 *   6. The hash input is `{ products: [...] }` ONLY — `revision` is
 *      NEVER part of the canonicalized/hashed payload (see
 *      catalogRevision.js for why: hashing a payload that already
 *      contains its own hash is circular).
 *
 * No Unicode normalization is applied — Step 2F Gate 4 explicitly
 * locks this out as unsupported by any current evidence.
 */

function compareProducts(a, b) {
  if (a.categoryOrder !== b.categoryOrder) return a.categoryOrder - b.categoryOrder;
  if (a.itemOrder !== b.itemOrder) return a.itemOrder - b.itemOrder;
  // productId tie-break: plain string comparison (Firestore auto-IDs
  // are ASCII-safe) — deliberately not locale-aware, matching Gate 4's
  // explicit "no Unicode normalization" instruction.
  if (a.productId < b.productId) return -1;
  if (a.productId > b.productId) return 1;
  return 0;
}

/**
 * Recursively alphabetize object keys and drop `undefined` values.
 * Arrays keep their element order; each element is canonicalized too.
 */
function canonicalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const result = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue(value[key]);
    }
    return result;
  }
  return value; // primitives (string, number, boolean, null) pass through unchanged
}

/**
 * @param {object[]} projectedProducts - output of catalogProjection.projectProduct(), one per product
 * @returns {{ sortedProducts: object[], canonicalJson: string }}
 *   `canonicalJson` is the exact string that catalogRevision.js hashes,
 *   and is also the exact byte content later written to
 *   /catalog/<revision>.json (with `revision` added afterward — see
 *   catalogRevision.js).
 */
function canonicalizeCatalog(projectedProducts) {
  const sortedProducts = [...projectedProducts].sort(compareProducts);
  const canonicalPayload = canonicalizeValue({ products: sortedProducts });
  const canonicalJson = JSON.stringify(canonicalPayload);
  return { sortedProducts, canonicalJson };
}

module.exports = { canonicalizeCatalog, canonicalizeValue, compareProducts };
