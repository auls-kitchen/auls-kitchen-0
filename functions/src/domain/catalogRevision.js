/**
 * catalogRevision (domain)
 *
 * Pure business logic — no Firestore I/O, no external calls.
 *
 * Computes the Catalog Snapshot's content-addressed revision, per
 * Step 2F Gate 4/Gate 5 (LOCKED):
 *
 *   revision = SHA-256(canonical projected catalog JSON), hex-encoded.
 *
 * Uses Node.js's built-in `crypto` module — no new dependency (Node 20
 * ships it natively; confirmed available in this project's runtime).
 *
 * CIRCULARITY (resolved, LOCKED): the hash input MUST NOT contain the
 * `revision` field itself — `catalogCanonicalization.canonicalizeCatalog()`
 * already guarantees this by construction (its canonical payload is
 * only `{ products: [...] }`). `revision` is computed from that
 * canonical string, then added to the snapshot/manifest objects
 * afterward — never before, never as part of what gets hashed.
 */

const crypto = require("crypto");

/**
 * @param {string} canonicalJson - the exact string produced by
 *   `catalogCanonicalization.canonicalizeCatalog().canonicalJson`.
 * @returns {string} lowercase hex SHA-256 digest.
 */
function computeRevision(canonicalJson) {
  return crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

module.exports = { computeRevision };
