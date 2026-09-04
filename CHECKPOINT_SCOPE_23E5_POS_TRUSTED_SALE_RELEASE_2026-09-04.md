# CHECKPOINT — SCOPE 23E-5 — RELEASE / DEPLOYMENT RECORD

## POS Trusted Checkout (Scope 23D-2) — Release Readiness

Date: 2026-09-04

## 1. Baseline

Current `main` HEAD:
`fef869ad43314a5727faeab9cd089df7e540f195`

23D-2 implementation chain:
```
e5a8dfbb1ea5c9df32146b4e8427a260e11949b5  feat(pos): add productId and anonymous auth bridge (Scope 23D-1)
        ↓
3f4ba9800af46dc12be10382750c55ed7405cf6e  feat(pos): migrate checkout to trusted posSale backend (Scope 23D-2)
        ↓
fef869ad43314a5727faeab9cd089df7e540f195  docs: close scope 23d-2 checkpoint
```

Working tree at the time of this checkpoint intentionally contains:
```
 M firebase.json
?? firestore.rules
```
These two files are local Firebase Emulator Suite configuration introduced in Scope 23D-2-EMU-4. They are **not** production security policy or production deployment configuration, they remain uncommitted by design, and they must not be deployed or removed.

## A. Implementation Status

- Scope 23D-1 (ProductId + Anonymous Auth client bridge) is **complete** — `PRODUCT_ID_MAP`, `data-product-id`, ticket `productId`, `getAuth`/`signInAnonymously`/`onAuthStateChanged`/`authReady`/`getCurrentAuthUid` all present and wired in `aul-pos.html` on current `main`.
- Scope 23D-2 (POS Trusted Checkout migration) is **complete** — POS checkout calls the backend callable function `posSale` (`getFunctions(firebaseApp, "us-central1")` + `httpsCallable(functionsClient, "posSale")`).
- The client does **not** send price, HPP, recipe, stock, total, or kasir identity as authority — `buildPosSaleRequest()` sends only `idempotencyKey`, `items[].{productId, quantity, selectedModifiers[].{groupId, optionId}}`, `paymentMethod`, `cashReceived`, `customerName`.
- The backend (`functions/src/functions/posSale.js`, unchanged since Scope 23C's production-verified deploy) is authoritative for product identity, price, modifiers, recipe, stock validation, HPP, authoritative total, cash validation/change, transaction creation, and idempotency.
- The transaction document ID is the client-supplied `idempotencyKey` (`transactions/{idempotencyKey}`), with the backend enforcing same-actor-safe-replay / different-actor-conflict semantics.
- The trusted actor identity is the Firebase Auth UID (`request.auth.uid`, via `requireAuth()`) — never a client-supplied field.
- QRIS remains visible in the UI but is marked `.unavailable` and non-selectable; the backend accepts only `"Cash"` as `paymentMethod` (`PAYMENT_METHOD_NOT_SUPPORTED` otherwise).

## B. Backend Runtime Verification

Scopes EMU-7 through EMU-21 were verified against the Firebase Local Emulator Suite (Functions/Firestore/Auth), running the exact `functions/` source that is on current `main`. Verified categories:

- Successful cash sale
- Same-owner idempotency replay
- Different-owner idempotency conflict
- Insufficient cash
- Insufficient stock
- Product unavailable
- Ingredient unavailable
- Successful sale with modifier
- Required modifier missing
- Invalid modifier option
- Invalid modifier group
- Invalid quantity
- Unsupported non-Cash payment method
- Empty payment method
- Unauthenticated request

Every rejection case verified in this battery produced **zero mutation** (proven via BEFORE/AFTER Firestore snapshot comparison — byte-level and semantic).

**Important nuance (EMU-19):** the test expected `INVALID_PAYMENT_METHOD` for `paymentMethod: "Transfer"`; the actual, source-correct backend behavior returned `PAYMENT_METHOD_NOT_SUPPORTED` instead (a well-formed-but-unsupported payment method is validated by `validatePayment()` in `functions/src/functions/posSale.js`, which is a distinct check from the request-shape validation `INVALID_PAYMENT_METHOD` in `functions/src/domain/posSale.js`). This is a **test expectation mismatch, not a backend defect** — the backend matched its own source exactly.

- EMU-20 (empty payment method): returned `INVALID_PAYMENT_METHOD`, as expected.
- EMU-21 (no Auth token): returned `UNAUTHENTICATED`, as expected.

State: **BACKEND RUNTIME = PASS.**

## C. Production Manual Verification

The following manual production verification was reported as performed by the operator (outside this session's own tool access — this session has no credentials or mechanism to invoke production Firebase itself, and did not perform this transaction):

- Production POS opened at `https://aulia.fun/aul-pos`.
- Product **Java Aren** was selected.
- Java Aren had no modifiers and appeared in the ticket as "Original".
- Ticket showed Java Aren, quantity 1, at Rp 10.000.
- Cash payment method was selected.
- Cash received entered: Rp 10.000.
- Checkout completed successfully; the POS UI displayed "Transaksi Berhasil".
- The resulting Firestore production `transactions` record was then inspected and showed `cashReceived: 10000` and `change: 0`.
- The transaction record contained backend-generated financial data, including an `hppSnapshot`.
- The transaction's `selectedModifiers` array was empty, consistent with Java Aren being sold with no modifier selected.

This is reported evidence of a real, successful production `posSale` invocation and its resulting authoritative transaction record. It directly demonstrates the backend-authoritative checkout flow (client request → backend price/HPP/stock resolution → atomic transaction commit → backend-authoritative response) functioning end-to-end against live production infrastructure for one Cash sale.

**Explicitly not claimed:** this production transaction does not, by itself, establish which Cloudflare Worker deployment/version served the page that produced it. No deployment-metadata correlation was performed as part of this manual test, and none is claimed here.

## D. Browser E2E Environment Limitation

- A UI browser end-to-end test against the Firebase Local Emulator Suite was attempted (Scope 23D-2-UI-2).
- The attempt could not complete: all four Firebase Web SDK ES module imports in `aul-pos.html` (and its emulator-connected temporary test copy) resolve to `https://www.gstatic.com/firebasejs/10.12.2/`, and this sandbox's outbound egress policy denies CONNECT access to `www.gstatic.com:443` (confirmed independently via both the browser's own network log and a direct `curl` CONNECT test).
- The local Functions/Firestore/Auth emulators themselves were healthy and correctly configured (`posSale` registered and reachable at `http://127.0.0.1:5001/auls-kitchen/us-central1/posSale`).
- Local Firestore seed data (test product/ingredient) was written and confirmed successfully via direct REST calls.
- No production fallback occurred — because the SDK's ES module imports never resolved, zero top-level statements in the page's script executed at all (not `initializeApp()`, not the emulator-connect calls, not any application logic), and the captured network log shows zero requests to any local emulator port or any production Firebase endpoint during the entire attempt.
- No application source workaround (rehosting the SDK, rewriting import URLs, or any other change to `aul-pos.html`) was authorized or performed.
- **Browser E2E therefore remains BLOCKED by this sandbox's environment/tooling — a documented verification-environment limitation, not an identified application defect.** (Scope 23D-2-UI-3 additionally confirmed no local/offline copy of the Firebase Web SDK exists anywhere in this sandbox as an alternative path.)

The manual production verification recorded in Section C above independently exercises the real checkout flow end-to-end against live infrastructure, which materially narrows — though does not by itself fully substitute for — the residual risk left by this environment limitation.

## E. Cloudflare Deployment Evidence

The following was reported/observed via the Cloudflare dashboard (outside this sandbox's own access — this session has no Cloudflare credentials and could not independently query this data; see Scope "DEPLOYMENT EVIDENCE ONLY — CLOUDFLARE 23D-2" and Scope 23E-1A for this session's own exhaustive, unsuccessful attempts to establish this by itself):

- Worker: `auls-kitchen-0`
- Production custom domain: `aulia.fun`
- Deployment source shown in Cloudflare's history as: Wrangler
- Version `d14d8741` was visible in the deployment history, with a deployment message beginning with "docs: close scope 23d-2 checkpoint"
- The version-specific preview URL for that deployment was reachable and displayed the AUL's Kitchen menu.

**Explicitly not claimed:** that `d14d8741` is definitively the version currently serving 100% of production traffic on `aulia.fun`. Dashboard evidence reviewed in Scope 23E-3 was self-reported as showing an inconsistency on this specific point (an Active-deployment card reportedly showing 0% traffic alongside separate history context showing this version) — this checkpoint does not resolve that inconsistency and does not assert a traffic-percentage claim beyond what is directly evidenced. Likewise, `d14d8741`'s exact source-code identity relative to git commit `fef869a` has not been independently confirmed via any deployment-metadata API (no such access exists from this sandbox).

No Promote, Rollback, Deploy, or other Cloudflare mutation was performed as part of this checkpoint or any scope contributing to it.

## F. Release Decision

**Scope 23D-2 implementation is complete and backend runtime verification is PASS.**

**Browser UI E2E verification remains BLOCKED by sandbox Firebase Web SDK availability / outbound CDN access.**

**23D-2 is closed with a documented environment limitation; no application workaround is authorized.**

For Scope 23E-5, the current state is assessed as **RELEASE READY**, based on:
- complete, source-verified implementation (Section A),
- comprehensive backend emulator runtime evidence against the exact code that is live in production (Section B),
- a reported, successful, real production Cash-sale transaction exercising the full trusted-checkout path end-to-end (Section C),
- a documented, non-application environment limitation on browser E2E (Section D), which does not indicate any defect in the shipped code.

The relationship between Cloudflare deployment version `d14d8741` and the exact frontend source currently served remains explicitly **unconfirmed** (Section E) and is not required to be resolved for this RELEASE READY assessment, since Section C's reported production transaction already demonstrates the live-serving frontend successfully completed a real trusted checkout — which is the behavior that matters, independent of which specific deployment version's dashboard label produced it.

## G. Known Non-Release Features

- QRIS / non-Cash payment methods: visible in the UI but inert; not implemented in this release. Future scope.
- Kiosk (Self-Order "Aul"): not started, not part of this release.
- Kitchen Display System: not started, not part of this release.
- Dynamic QRIS: not started, not part of this release.
- Local Firebase Emulator configuration (`firebase.json`'s `emulators` block, `firestore.rules`): intentionally excluded from this release; local-development/testing artifacts only, never committed.

## H. Standing Working Tree

```
 M firebase.json
?? firestore.rules
```
Unchanged by this checkpoint. Not committed, not pushed, not deployed, per standing instruction across every prior scope in this release effort.
