"use strict";

/**
 * Kiosk persistence adapter - storage-agnostic core logic.
 *
 * This module has NO Firebase, NO Firestore, NO Cloud Functions, NO
 * OrderIntent, NO AWR/PixiJS, NO payment provider dependency. It never
 * calls OrderIntent and never generates an idempotencyKey - it only
 * stores and retrieves whatever its caller supplies.
 *
 * It depends on an injected `store` with exactly three async methods:
 *   store.get(key)    -> resolves to the stored value, or undefined/null
 *                        if nothing is stored; MAY reject on read failure.
 *   store.set(key,val)-> resolves on success; MAY reject on write failure.
 *   store.delete(key) -> resolves on success; MAY reject on failure.
 *
 * This is the ONLY dependency boundary - a real IndexedDB-backed store
 * (see indexedDbAdapter.js) or a plain in-memory store (used by this
 * module's own tests) can both satisfy it without this file changing at
 * all. See persistenceTypes.js's header comment for the documented
 * single-record storage layout.
 */

const {
  CURRENT_SCHEMA_VERSION,
  ResultCodes,
  WriteErrorCodes,
  isPlainObject,
  isNonEmptyString,
  isFiniteNumber,
  isValidCartDraft,
  isValidSubmissionAttemptForSave,
  isValidStoredSubmissionAttempt,
  isValidAuthoritativeResult,
} = require("./persistenceTypes");

const STORAGE_KEY = "kioskCustomerContext";

function isUsableSameOwnerRecord(raw, ownerUid) {
  return (
    isPlainObject(raw) &&
    raw.schemaVersion === CURRENT_SCHEMA_VERSION &&
    isNonEmptyString(raw.ownerUidAtWrite) &&
    raw.ownerUidAtWrite === ownerUid
  );
}

/**
 * Creates a persistence adapter bound to the given injected store.
 */
function createPersistenceAdapter(store) {
  async function readRaw() {
    try {
      const raw = await store.get(STORAGE_KEY);
      return { failed: false, raw: raw === undefined ? null : raw };
    } catch (error) {
      return { failed: true, error };
    }
  }

  /**
   * Read-modify-write helper. `mutate(baseRecord, now)` receives either
   * a fresh base record (no existing record, a different owner, or an
   * unusable/corrupt one) or the existing same-owner record carried
   * over as-is (its other domains are NOT re-validated here - load()
   * is the single source of truth for corruption detection, so a save
   * never silently "fixes" or drops another domain's existing data).
   *
   * If reading the existing record fails outright, the write is
   * refused entirely (WRITE_FAILURE) rather than risk silently
   * discarding an existing, possibly-unresolved SubmissionAttempt by
   * blindly writing a fresh record over it.
   */
  async function readModifyWrite(ownerUid, mutate) {
    const read = await readRaw();
    if (read.failed) {
      return { ok: false, code: WriteErrorCodes.WRITE_FAILURE, error: read.error };
    }

    const now = Date.now();
    const usable = isUsableSameOwnerRecord(read.raw, ownerUid);
    const base = usable
      ? read.raw
      : {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          ownerUidAtWrite: ownerUid,
          writtenAt: now,
          cartDraft: null,
          submissionAttempt: null,
          authoritativeResult: null,
        };

    const nextRecord = mutate(base, now);

    try {
      await store.set(STORAGE_KEY, nextRecord);
    } catch (error) {
      return { ok: false, code: WriteErrorCodes.WRITE_FAILURE, error };
    }
    return { ok: true };
  }

  async function saveCartDraft(ownerUid, cartDraft) {
    if (!isNonEmptyString(ownerUid) || !isValidCartDraft(cartDraft)) {
      return { ok: false, code: WriteErrorCodes.VALIDATION_FAILURE };
    }
    return readModifyWrite(ownerUid, (base, now) => ({
      ...base,
      ownerUidAtWrite: ownerUid,
      writtenAt: now,
      cartDraft: { ...cartDraft, writtenAt: now },
    }));
  }

  async function saveSubmissionAttempt(ownerUid, submissionAttempt) {
    if (!isNonEmptyString(ownerUid) || !isValidSubmissionAttemptForSave(submissionAttempt)) {
      return { ok: false, code: WriteErrorCodes.VALIDATION_FAILURE };
    }
    return readModifyWrite(ownerUid, (base, now) => ({
      ...base,
      ownerUidAtWrite: ownerUid,
      writtenAt: now,
      submissionAttempt: { ...submissionAttempt, writtenAt: now },
    }));
  }

  async function saveAuthoritativeResult(ownerUid, idempotencyKey, authoritativeResult) {
    if (
      !isNonEmptyString(ownerUid) ||
      !isNonEmptyString(idempotencyKey) ||
      !isValidAuthoritativeResult(authoritativeResult)
    ) {
      return { ok: false, code: WriteErrorCodes.VALIDATION_FAILURE };
    }
    return readModifyWrite(ownerUid, (base, now) => ({
      ...base,
      ownerUidAtWrite: ownerUid,
      writtenAt: now,
      authoritativeResult: {
        ...authoritativeResult,
        idempotencyKey,
        writtenAt: now,
      },
    }));
  }

  /**
   * Removes ONLY the SubmissionAttempt domain, once the caller (a
   * future Submission layer) has determined a terminal outcome
   * (SUCCEEDED/REJECTED). Never touches CartDraft or
   * AuthoritativeResult - their lifecycles are independent (STEP 55 S9,
   * STEP 56 S11).
   */
  async function removeSubmissionAttempt(ownerUid) {
    if (!isNonEmptyString(ownerUid)) {
      return { ok: false, code: WriteErrorCodes.VALIDATION_FAILURE };
    }
    return readModifyWrite(ownerUid, (base, now) => ({
      ...base,
      writtenAt: now,
      submissionAttempt: null,
    }));
  }

  async function removeAuthoritativeResult(ownerUid) {
    if (!isNonEmptyString(ownerUid)) {
      return { ok: false, code: WriteErrorCodes.VALIDATION_FAILURE };
    }
    return readModifyWrite(ownerUid, (base, now) => ({
      ...base,
      writtenAt: now,
      authoritativeResult: null,
    }));
  }

  /**
   * Removes the entire persisted customer context. This is a pure
   * storage operation: it does NOT rotate Auth, does NOT decide
   * whether Session End is valid, and does NOT decide whether a
   * Payment/OrderIntent outcome is ambiguous - those are the future
   * Session layer's responsibilities (STEP 56 S12). It always executes
   * unconditionally when called.
   */
  async function purgeCustomerContext() {
    try {
      await store.delete(STORAGE_KEY);
    } catch (error) {
      return { ok: false, code: WriteErrorCodes.DELETE_FAILURE, error };
    }
    return { ok: true };
  }

  /**
   * Loads the persisted customer context for currentOwnerUid.
   *
   * expiryOptions (optional): { cartDraftMaxAgeMs, submissionAttemptMaxAgeMs,
   * authoritativeResultMaxAgeMs }. When given, the returned envelope
   * includes purely INFORMATIONAL *Expired flags - they never cause
   * this method to discard, alter, or reinterpret anything. An expired
   * unresolved SubmissionAttempt is still returned completely intact,
   * with its original status untouched (STEP 55 S14 / STEP 56 S13: an
   * expired local record must never be conflated with a resolved one).
   */
  async function load(currentOwnerUid, expiryOptions) {
    const opts = expiryOptions || {};
    const read = await readRaw();
    if (read.failed) {
      return { status: ResultCodes.READ_FAILURE, error: read.error };
    }
    if (read.raw === null) {
      return { status: ResultCodes.EMPTY };
    }

    const raw = read.raw;

    if (
      !isPlainObject(raw) ||
      !isNonEmptyString(raw.ownerUidAtWrite) ||
      !isFiniteNumber(raw.writtenAt) ||
      raw.schemaVersion === undefined
    ) {
      return { status: ResultCodes.CORRUPT_RECORD };
    }

    if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      return { status: ResultCodes.UNSUPPORTED_SCHEMA, foundSchemaVersion: raw.schemaVersion };
    }

    if (raw.cartDraft !== null && raw.cartDraft !== undefined) {
      if (!isValidCartDraft(raw.cartDraft) || !isFiniteNumber(raw.cartDraft.writtenAt)) {
        return { status: ResultCodes.CORRUPT_RECORD };
      }
    }
    if (raw.submissionAttempt !== null && raw.submissionAttempt !== undefined) {
      if (!isValidStoredSubmissionAttempt(raw.submissionAttempt)) {
        return { status: ResultCodes.CORRUPT_RECORD };
      }
    }
    if (raw.authoritativeResult !== null && raw.authoritativeResult !== undefined) {
      if (
        !isValidAuthoritativeResult(raw.authoritativeResult) ||
        !isFiniteNumber(raw.authoritativeResult.writtenAt) ||
        !isNonEmptyString(raw.authoritativeResult.idempotencyKey)
      ) {
        return { status: ResultCodes.CORRUPT_RECORD };
      }
    }

    if (raw.ownerUidAtWrite !== currentOwnerUid) {
      // Hard isolation gate: do not hydrate ANY of it, for ANY domain.
      return { status: ResultCodes.UID_MISMATCH };
    }

    const now = Date.now();
    const cartDraft = raw.cartDraft || null;
    const submissionAttempt = raw.submissionAttempt || null;
    const authoritativeResult = raw.authoritativeResult || null;

    const cartDraftExpired =
      cartDraft && isFiniteNumber(opts.cartDraftMaxAgeMs)
        ? now - cartDraft.writtenAt > opts.cartDraftMaxAgeMs
        : false;
    const submissionAttemptExpired =
      submissionAttempt && isFiniteNumber(opts.submissionAttemptMaxAgeMs)
        ? now - submissionAttempt.writtenAt > opts.submissionAttemptMaxAgeMs
        : false;
    const authoritativeResultExpired =
      authoritativeResult && isFiniteNumber(opts.authoritativeResultMaxAgeMs)
        ? now - authoritativeResult.writtenAt > opts.authoritativeResultMaxAgeMs
        : false;

    return {
      status: ResultCodes.VALID,
      cartDraft,
      submissionAttempt,
      authoritativeResult,
      cartDraftExpired,
      submissionAttemptExpired,
      authoritativeResultExpired,
      meta: {
        schemaVersion: raw.schemaVersion,
        ownerUidAtWrite: raw.ownerUidAtWrite,
        writtenAt: raw.writtenAt,
      },
    };
  }

  return {
    saveCartDraft,
    saveSubmissionAttempt,
    saveAuthoritativeResult,
    removeSubmissionAttempt,
    removeAuthoritativeResult,
    purgeCustomerContext,
    load,
  };
}

module.exports = { createPersistenceAdapter, STORAGE_KEY };
