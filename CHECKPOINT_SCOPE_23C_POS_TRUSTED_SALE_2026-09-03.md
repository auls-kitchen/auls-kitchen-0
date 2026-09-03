# CHECKPOINT — Scope 23C
## POS Trusted Sale Boundary

**Date:** 2026-09-03  
**Status:** CLOSED / PRODUCTION VERIFIED

---

## 1. Scope Objective

Move POS checkout authority from the browser to the trusted backend without rewriting the existing POS UI.

Locked principle:

> UI = preview & request  
> Backend = decide & commit

---

## 2. Trusted Backend

Implemented and deployed:

- Firebase Cloud Function: `posSale`
- Region: `us-central1`

Backend is authoritative for:

- product identity
- product name
- base price
- modifier name and price
- recipe
- ingredient requirement
- stock validation
- HPP
- HPP snapshot
- authoritative transaction total
- cash validation
- change
- transaction creation
- idempotency
- trusted actor identity via Firebase Auth UID

---

## 3. Atomic Stock and Transaction Commit

The POS sale boundary uses one Firestore transaction for:

1. idempotency guard
2. ingredient reads
3. complete stock validation
4. stock decrement
5. transaction creation

If stock is insufficient, the transaction aborts and no partial stock/transaction write is committed.

No external API calls are performed inside the Firestore transaction.

---

## 4. Idempotency and Transaction Identity

Locked identity model:

- `idempotencyKey` = technical retry identity
- `transactionId` = Firestore transaction document identity
- `noStruk` = business/receipt identity

Transaction document identity:

`transactions/{idempotencyKey}`

Behavior:

- same actor + same key = safe replay
- different actor + same key = `IDEMPOTENCY_KEY_CONFLICT`
- network timeout = retry using the same key
- double-click = same key, not a new transaction

---

## 5. Historical Financial Integrity

HPP is captured as a historical snapshot at transaction time.

Snapshot includes:

- base HPP per unit
- modifier HPP per unit
- total HPP per unit
- item total HPP
- base recipe
- modifier detail
- ingredient ID and name
- quantity
- `costAtTransaction`
- subtotal

HPP rounding rule:

`Math.ceil(baseHppPerUnit + modifierHppPerUnit)`

Rounding is performed once at the required level.

Historical transactions must not be recalculated from current product or ingredient master data.

Finance must read the transaction HPP snapshot.

---

## 6. Payment Semantics

### Cash

Backend validates:

`cashReceived >= authoritativeTotal`

Change:

`change = cashReceived - authoritativeTotal`

Insufficient cash returns:

`INSUFFICIENT_CASH`

and does not commit the sale or stock decrement.

### QRIS

QRIS final payment lifecycle is NOT finalized by Scope 23C.

QRIS payment creation/confirmation/finalization remains a separate future scope.

---

## 7. Authorization

Trusted actor identity:

`request.auth.uid`

Anonymous Auth remains the authentication mechanism for this scope.

Client-side `kasir` is not a security authority.

Cashier display information may remain as compatibility data, but authorization and ownership are based on the Firebase Auth UID.

---

## 8. Live Verification

Production verification harness completed successfully.

Verified:

- Anonymous Auth
- Call #1 NEW
- Call #2 REPLAY
- transaction exists
- transaction ID equals idempotency key
- transaction total exists
- stock decremented exactly once
- HPP snapshot exists

Result:

**LIVE VERIFICATION: PASS**

---

## 9. GitHub Verification

Scope 23C was implemented on:

`scope-23c-pos-completesale`

Pull Request:

`#3 — Scope 23C POS CompleteSale`

PR #3 was merged into `main`.

Merge commit:

`4879625`

GitHub showed the merge commit as verified.

---

## 10. Firebase Production Verification

Firebase Functions production dashboard confirms:

- `posSale` deployed
- region: `us-central1`
- `orderIntent` deployed
- `healthCheck` deployed

`posSale` is therefore present in the Firebase production Functions environment.

---

## 11. Cloudflare Production Verification

Cloudflare Worker:

`auls-kitchen-0`

Latest observed production deployment:

`v1818eb42`

Traffic:

`100%`

Cloudflare deployment history confirms the current deployment is serving production traffic.

---

## 12. POS Migration Boundary

Scope 23C does NOT rewrite the existing POS UI.

The following remain client-side UI responsibilities:

- menu
- categories
- product selection
- modifier selection
- cart/ticket
- customer name
- payment modal
- receipt display
- printing

The browser is no longer intended to be the final authority for:

- price
- total
- HPP
- stock mutation
- transaction creation

`status/txPopup` remains outside the financial atomic commit and is not part of this scope's trusted transaction boundary.

---

## 13. Next Scope Boundary

Scope 23C does not automatically open the next implementation scope.

Planned next work:

> Surgical migration of POS `completeSale()` so it calls the trusted `posSale` backend while preserving the existing POS UI and receipt/printing behavior.

No broad POS rewrite or unnecessary refactor is authorized.

Before starting the next scope:

> Checkpoint → Backup → New Scope → Implement → Verify

---

# FINAL DECLARATION

**Scope 23C — POS Trusted Sale Boundary is CLOSED / PRODUCTION VERIFIED.**

No additional code change is required to close Scope 23C.
