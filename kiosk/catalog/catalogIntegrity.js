"use strict";

/**
 * Kiosk Catalog integrity verification.
 *
 * The revision is SHA-256 over the CANONICAL JSON of the products - not
 * over the raw snapshot bytes. The snapshot file itself is serialized as
 * { revision, products } in projection key order, so hashing the file
 * would never match. Verification is therefore:
 *
 *   snapshot.products
 *     -> canonicalizeCatalog()   (the publisher's own module, reused)
 *     -> canonical JSON
 *     -> SHA-256 (WebCrypto)
 *     -> compare with snapshot.revision
 *
 * canonicalizeCatalog is required straight from functions/src/domain/ -
 * a pure module with no dependencies - so there is exactly ONE
 * canonicalization algorithm for publisher and consumer.
 */

const { canonicalizeCatalog } = require("../../functions/src/domain/catalogCanonicalization");
const { CatalogError, CATALOG_ERROR_CODES } = require("./catalogContract");

function defaultSubtle() {
  const cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  return cryptoObject && cryptoObject.subtle ? cryptoObject.subtle : null;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * @param {object[]} products - snapshot.products
 * @param {SubtleCrypto} [subtle] - injectable; defaults to globalThis.crypto.subtle
 * @returns {Promise<string>} lowercase hex SHA-256 of the canonical catalog JSON
 */
async function computeCatalogRevision(products, subtle) {
  const digestProvider = subtle || defaultSubtle();
  if (!digestProvider) {
    throw new Error("catalogIntegrity: WebCrypto SubtleCrypto is not available");
  }
  const { canonicalJson } = canonicalizeCatalog(products);
  const digest = await digestProvider.digest("SHA-256", new TextEncoder().encode(canonicalJson));
  return toHex(digest);
}

/**
 * @param {{revision: string, products: object[]}} snapshot - already structurally parsed
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<void>} resolves only when the recomputed hash equals snapshot.revision
 * @throws {CatalogError} INTEGRITY_MISMATCH
 */
async function verifySnapshotIntegrity(snapshot, subtle) {
  const computed = await computeCatalogRevision(snapshot.products, subtle);
  if (computed !== snapshot.revision) {
    throw new CatalogError(CATALOG_ERROR_CODES.INTEGRITY_MISMATCH, "canonical SHA-256 does not match the snapshot revision");
  }
}

module.exports = { computeCatalogRevision, verifySnapshotIntegrity };
