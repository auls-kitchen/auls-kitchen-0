/**
 * healthCheck
 *
 * SCOPE 16 — first trusted Cloud Function for AUL's Kitchen.
 *
 * Purpose (and ONLY purpose):
 *   Prove that this Cloud Functions runtime can execute and can safely
 *   read from the existing Firestore project (auls-kitchen) using the
 *   Admin SDK, before any business logic (Order Intent, reservation,
 *   payment, etc.) is implemented.
 *
 * Hard constraints for this function (Scope 16):
 *   - No customer authentication required.
 *   - No business mutation of any kind.
 *   - No payment, no reservation, no stock modification.
 *   - No Order Intent / Payment Intent / transaction creation.
 *   - No Midtrans involvement.
 *   - No customer data read or returned.
 *   - READ-ONLY against Firestore. It must never write anything,
 *     including to the harmless document it reads.
 *
 * It performs exactly one Firestore read, against the existing
 * `status/shopOpen` document (an operational, non-business-critical
 * document already used by Online Menu — see project source), purely
 * to prove Function -> Firestore connectivity. The document's content
 * is NOT returned to the caller; only the fact that the read succeeded
 * is reported, to avoid returning any Firestore data unnecessarily.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions/v2");

const HARMLESS_DOC_PATH = { collection: "status", doc: "shopOpen" };

/**
 * healthCheck (callable)
 *
 * Response shape (success):
 *   {
 *     ok: true,
 *     serverTime: <ISO 8601 string, from Cloud Functions server clock>,
 *     firestoreReachable: true,
 *     functionId: "healthCheck"
 *   }
 *
 * Response shape (failure): thrown as an HttpsError with a generic,
 * non-technical message. Full internal detail goes only to
 * structured logs (Cloud Logging), never to the caller.
 */
const healthCheck = onCall(async (request) => {
  const invokedAt = new Date().toISOString();

  logger.info("healthCheck: invoked", {
    functionId: "healthCheck",
    invokedAt,
  });

  let firestoreReachable = false;

  try {
    const db = getFirestore();
    // Read-only. Deliberately does not write, even to this same document.
    await db.collection(HARMLESS_DOC_PATH.collection).doc(HARMLESS_DOC_PATH.doc).get();
    firestoreReachable = true;
  } catch (err) {
    // Full detail stays server-side only. Never forwarded to the caller.
    logger.error("healthCheck: Firestore read failed", {
      functionId: "healthCheck",
      invokedAt,
      // err.message is logged for diagnosis; this is a Cloud Logging
      // entry (internal), not part of the client response.
      errorMessage: err && err.message ? err.message : "unknown error",
    });

    throw new HttpsError(
      "internal",
      "healthCheck could not complete. Please try again shortly."
    );
  }

  logger.info("healthCheck: success", {
    functionId: "healthCheck",
    invokedAt,
    firestoreReachable,
  });

  return {
    ok: true,
    serverTime: new Date().toISOString(),
    firestoreReachable,
    functionId: "healthCheck",
  };
});

module.exports = { healthCheck };
