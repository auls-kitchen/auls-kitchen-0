# CHECKPOINT — SCOPE 23D-2 — POS TRUSTED SALE BOUNDARY

Date: 2026-09-04

## 1. Implementation Commit

23D-2 implementation commit:
`3f4ba9800af46dc12be10382750c55ed7405cf6e`

origin/main:
`bb9ac0389dab621d708ad756070642a545153456`

Branch: `claude/auls-kitchen-repo-inspection-o0bxwi`

## 2. Locked Architecture

- **UI = preview & request.** `aul-pos.html` builds a ticket, previews price/total client-side for display only, and submits an *intent* to the backend. It never determines the authoritative price, recipe, HPP, stock effect, payment validity, transaction identity, or historical snapshot.
- **Backend = decide & commit.** The `posSale` Cloud Function (`functions/src/functions/posSale.js`) is the sole authority: it resolves product/recipe/modifiers server-side, computes the authoritative total and HPP snapshot, validates payment, checks and decrements stock, and creates the transaction document — all inside one Firestore transaction (`commitPosSale`, `functions/src/functions/posSale.js:118-240`).

## 3. Client Request Boundary

`buildPosSaleRequest()` (`aul-pos.html:1042-1057`) sends only the trusted-contract fields:

```
{
  idempotencyKey,
  items: [{ productId, quantity, selectedModifiers: [{ groupId, optionId }] }],
  paymentMethod,
  cashReceived,
  customerName
}
```

No price, unitPrice, modifier price, HPP, recipe, stock, total, kasir, or ownerUid is ever sent by the client — all of these are resolved/authorized server-side only. Verified against source at `functions/src/functions/posSale.js:242-352` and `functions/src/domain/posSale.js` (`validatePosSaleRequest`).

## 4. Idempotency Behavior

One idempotency key per sale *attempt* (`currentIdempotencyKey`, minted via `crypto.randomUUID()` only after auth is confirmed ready — `aul-pos.html:891-912`, `1142-1149`), reused across retries, cleared only on confirmed success or an explicit "KOSONGKAN" abandon. Backend replay pre-check and in-transaction re-check both live in `posSale.js` (`getTransaction` at line 281, `getTransactionInTransaction` at line 130): same key + same owner → returns the existing transaction (`alreadyExisted: true`) without re-executing side effects; same key + different owner → `IDEMPOTENCY_KEY_CONFLICT`. Empirically proven at the backend level in EMU-8/EMU-9 (same-owner replay, different-owner conflict).

## 5. QRIS / Non-Cash Payment

QRIS remains visible in the UI but inert — the payment-method button carries an `unavailable` guard (`aul-pos.html:844-851`) and is a UI-only affordance. Backend `validatePayment()` (`functions/src/functions/posSale.js:71-98`) accepts only `"Cash"`; any other value throws `OrderValidationError("PAYMENT_METHOD_NOT_SUPPORTED", ...)`. Non-Cash payment support is explicitly out of scope for 23D-2 and remains a future scope.

## 6. Response Adapter + Printing Preservation

`adaptPosSaleTransaction()` (`aul-pos.html:1107-1126`) maps the backend's authoritative transaction response into the exact shape the pre-existing receipt/kitchen-print builders (`buildReceiptBytes`, `buildKitchenReceiptBytes`, `aul-pos.html:1234-1307`) already expect — total, change, items[].name/qty/lineTotal, createdAt, noStruk all taken verbatim from the server response; only `kasir` is a display-only client override (`KASIR_NAME`, `aul-pos.html:884-889`). Printing functions themselves were not modified by 23D-2 and were not touched by any scope in this checkpoint's scope.

## 7. Backend Runtime Verification Results (Firebase Local Emulator Suite)

| Test | Result | Note |
|---|---|---|
| EMU-7 | PASS | Successful cash sale |
| EMU-8 | PASS | Successful sale with modifier |
| EMU-9 | PASS | Same-owner idempotency replay |
| EMU-10 | PASS | Different-owner idempotency conflict |
| EMU-11 | PASS | INSUFFICIENT_CASH |
| EMU-12 | PASS | INSUFFICIENT_STOCK |
| EMU-13 | PASS | PRODUCT_UNAVAILABLE |
| EMU-14 | PASS | INGREDIENT_UNAVAILABLE |
| EMU-15 | PASS | REQUIRED_MODIFIER_MISSING |
| EMU-16 | PASS | MODIFIER_OPTION_UNAVAILABLE |
| EMU-17 | PASS | MODIFIER_GROUP_UNAVAILABLE |
| EMU-18 | PASS | INVALID_QUANTITY |
| EMU-19 | **TEST EXPECTATION MISMATCH — NOT A BACKEND DEFECT.** Task expected `INVALID_PAYMENT_METHOD` for `paymentMethod: "Transfer"`; actual, source-correct behavior returns `PAYMENT_METHOD_NOT_SUPPORTED` (a well-formed-but-unsupported payment method is validated in `validatePayment()`, `functions/src/functions/posSale.js:71-98`, which is distinct from the request-shape check `INVALID_PAYMENT_METHOD` in `functions/src/domain/posSale.js:60-62`). Backend behavior matched source exactly; only the test's expected error code was wrong. | |
| EMU-20 | PASS | INVALID_PAYMENT_METHOD (empty string) — primary PASS gate (`details.code == INVALID_PAYMENT_METHOD`, message match) met exactly; a secondary expected-status assertion (`FAILED_PRECONDITION`) was noted as not matching the actual `INVALID_ARGUMENT` status and reported transparently, without altering the overall PASS. |
| EMU-21 | PASS | UNAUTHENTICATED — invocation with no Auth token rejected correctly, zero mutation |

All backend behavior for every case above matched the corresponding source code exactly, cross-checked against `functions/src/functions/posSale.js`, `functions/src/domain/posSale.js`, `functions/src/domain/pricingAndRecipe.js`, `functions/src/domain/hppSnapshot.js`, and `functions/src/services/authGuard.js`, with BEFORE/AFTER Firestore snapshot proof (byte-level + semantic) and zero-mutation proof for every rejection case.

## 8. UI / Browser-Level Verification Results

| Scope | Result | Note |
|---|---|---|
| 23D-2-UI-1 | READY | Inspection/design-only. Confirmed `aul-pos.html` cannot be safely runtime-tested against local emulators without either editing the tracked file or executing a separate copy; recommended a temporary, untracked, emulator-connected copy (Method 2) as the safe path. |
| 23D-2-UI-2 | **BLOCKED** | A byte-identical temporary copy of `aul-pos.html` was created outside the repository, diff-gated to exactly the six authorized emulator-connect insertions, and run against a freshly started Firebase Local Emulator Suite (Functions/Firestore/Auth all confirmed up, `posSale` registered) with locally seeded test data. The browser checkout could not proceed: all four Firebase Web SDK ES module imports resolve to `https://www.gstatic.com/firebasejs/10.12.2/`, and this sandbox's outbound egress proxy rejects CONNECT to `www.gstatic.com:443` (403, organization policy — confirmed independently via both the browser's own network log and a direct `curl` CONNECT test). Because ES module import resolution fails before the module body executes, zero lines of `aul-pos.html`'s script ever ran — not `initializeApp()`, not the emulator-connect calls, not the checkout logic. Zero requests reached any local emulator port and zero requests reached any production Firebase endpoint; the test failed closed. Tracked `aul-pos.html` confirmed byte-identical before and after. Temporary harness fully deleted after the run. |
| 23D-2-UI-3 | **BLOCKED** | Inspection-only scope to determine whether the Firebase Web SDK v10.12.2 browser modules could be sourced locally/offline instead. Confirmed no such modules exist anywhere in this sandbox: `functions/node_modules` contains only the server-side Admin SDK (`firebase-admin` v12.7.0, `firebase-functions` v5.1.1) plus a small set of low-level `@firebase/*` utility packages transitively pulled in by Admin's Realtime Database client (`database`, `database-compat`, `component`, `logger`, `util`, type-only packages) — none of which are, or can substitute for, the Web SDK's `@firebase/app`/`@firebase/firestore`/`@firebase/auth`/`@firebase/functions` client packages. No bare `firebase` npm package exists at the repo root, in the global npm root, or bundled inside globally-installed `firebase-tools`. The npm cache (`/root/.npm`, 296M) was searched and contains zero Firebase-Web-SDK-related artifacts. No vendored/static copy of the CDN files exists anywhere in the repository. Conclusion: no offline/local-module strategy is available; the only path forward requires network access this sandbox's policy denies. |
| Egress policy follow-up | Asked whether `www.gstatic.com:443` egress could be enabled for this session. Determined that outbound network policy is an environment-level setting chosen when the Claude Code environment was created, not adjustable from inside a running session — the user was directed to the environment configuration documentation. No change was made or is achievable from within this session. |

## 9. Explicit Statement — Environment Limitation, Not an Application Defect

Across UI-2 and UI-3, every verification step within this session's control succeeded: the emulator suite started cleanly with `posSale` correctly registered; local Firestore seed data was written and confirmed; the temporary copy was proven byte-identical to the tracked source plus exactly six authorized emulator-connect lines; the local static server served the copy correctly over `127.0.0.1`. The sole blocker — inability to load the Firebase Web SDK's ES modules from `https://www.gstatic.com/firebasejs/10.12.2/` — originates entirely from this sandbox's outbound network policy and the absence of any locally available copy of those exact modules. **Browser UI E2E verification is blocked by a sandbox/environment limitation, not by any defect, mismatch, or gap in `aul-pos.html`'s application logic or in the `posSale` backend.**

## 10. Production Safety

- No production Firebase project (`auls-kitchen`) or the separate `aul-s-kitchen-test` project was ever contacted by any scope in the 23D-2 verification effort (EMU-7 through EMU-21, UI-1 through UI-3). Every backend test ran exclusively against the local Firebase Emulator Suite (`127.0.0.1:5001`/`8080`/`9099`); every UI test attempt was proven, via captured network evidence, to have made zero requests to any production Firebase endpoint, `*.googleapis.com` (Firebase APIs), `*.cloudfunctions.net`, `firebaseapp.com`, or the production hosting URLs — it failed closed rather than open.
- No deploy occurred at any point across this checkpoint's covered scopes.
- No merge, push, or PR occurred at any point across this checkpoint's covered scopes.
- No service-account credentials were created; no Blaze-tier feature was enabled or used.
- Tracked application source (`aul-pos.html`, `functions/`) and `.firebaserc` remain byte-identical to the 23D-2 implementation commit throughout every scope in this checkpoint.

## 11. Current Worktree State

```
 M firebase.json
?? firestore.rules
```

These two files are the intentional, explicitly-authorized local-emulator-only configuration from Scope 23D-2-EMU-4 (required solely so `firebase emulators:start` can boot Functions/Firestore/Auth locally). They are not production security policy and have not been committed or pushed at any point in this checkpoint's covered history.

## 12. Closure Statement

Scope 23D-2 implementation is complete and backend runtime verification is PASS.

Browser UI E2E verification remains BLOCKED by sandbox Firebase Web SDK availability / outbound CDN access.

23D-2 is closed with a documented environment limitation; no application workaround is authorized.

## 13. Next Scope

TO BE DECIDED AFTER CHECKPOINT REVIEW
