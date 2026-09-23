/**
 * catalogPublishPlan (domain)
 *
 * Pure business logic — no Firestore I/O, no Storage I/O, no external
 * calls. Composes the pure steps of Step 2F Gate 5's publish sequence
 * (steps 2-5 — validation, projection, canonicalization, hashing) into
 * one orchestrator, so the callable (Phase C) stays a thin I/O shell.
 *
 * D1 (LOCKED): if ANY product fails validation, the entire plan fails —
 * no partial catalog is ever projected/canonicalized/hashed. The
 * caller (publish callable) must not perform ANY Storage write when
 * this returns `ok: false`.
 */

const { validateProduct } = require("./catalogValidation");
const { projectProduct } = require("./catalogProjection");
const { canonicalizeCatalog } = require("./catalogCanonicalization");
const { computeRevision } = require("./catalogRevision");

/**
 * @param {object[]} rawProducts - raw Product Master documents, each
 *   `{ id, ...firestoreData }` (the shape `productsRepo.listProducts()` returns).
 * @returns {
 *   { ok: false, validationFailures: Array<{productId: string|null, errors: string[]}> } |
 *   { ok: true, revision: string, canonicalJson: string, products: object[], productCount: number }
 * }
 */
function buildCatalogPublishPlan(rawProducts) {
  const validationFailures = [];
  for (const raw of rawProducts) {
    const result = validateProduct(raw);
    if (!result.ok) {
      validationFailures.push({ productId: result.productId, errors: result.errors });
    }
  }

  if (validationFailures.length > 0) {
    // D1: entire publish fails. No projection, no canonicalization, no
    // hash, no Storage write is ever attempted from this failure path.
    return { ok: false, validationFailures };
  }

  const projectedProducts = rawProducts.map(projectProduct);
  const { sortedProducts, canonicalJson } = canonicalizeCatalog(projectedProducts);
  const revision = computeRevision(canonicalJson);

  return {
    ok: true,
    revision,
    canonicalJson,
    products: sortedProducts,
    productCount: sortedProducts.length,
  };
}

module.exports = { buildCatalogPublishPlan };
