# CHECKPOINT — STEP 89: REAL FUNCTIONS EMULATOR ORDERINTENT VERIFICATION

Date: 2026-09-18

## 1. Checkpoint Identity

- Scope name: Real Functions Emulator OrderIntent Verification (STEP 89)
- Branch: `step87-auth-browser`
- HEAD before this checkpoint: `8ac509dcb4816321360a48741920f78d5ec1c581` ("docs: checkpoint Remote Control physical continuity audit (2026-09-18)")
- STEP 89 status: **VERIFIED, with one discovered-and-documented (not fixed) defect** — see Section 6.
- Remote status: NOT PUSHED

This is the exact remaining gap named in `CHECKPOINT_STEP87_88_KIOSK_REAL_BROWSER_AUTH_2026-09-15.md`'s "Next Planned Sequence": verifying `httpsCallable("orderIntent")` against a real Firebase Functions Emulator running the actual `functions/` source, the one seam STEP88 kept CONTROLLED (`controlledGetFunctions`/`controlledHttpsCallable`, constructed but never invoked).

## 2. Firestore Emulator Status (Guru-review requirement — determined by observation, not assumed)

Two questions were kept explicitly separate, per review:

**(a) Is a running Firestore Emulator process required?** Yes, by source inspection: `functions/src/repositories/productsRepo.js`, `ingredientsRepo.js`, `orderIntentsRepo.js` call `getFirestore()` directly, and `functions/src/domain/reservation.js`'s `reserveOrderIntent` runs a real `db.runTransaction` that the success/replay/insufficient-stock outcomes all depend on.

**(b) Is a `firestore.rules` file required merely for the emulator to start?** **NO — confirmed by direct observation.** `firebase.json` was given only `emulators.functions` (port 5001) and `emulators.firestore` (port 8080) — no top-level `firestore` product key, no rules file was created. Starting `firebase emulators:start --only auth,functions,firestore --project demo-orderintent-test` produced this exact CLI output:

```
!  firestore: Did not find a Cloud Firestore rules file specified in a firebase.json config file.
!  firestore: The emulator will default to allowing all reads and writes.
+  firestore: Firestore Emulator was started in standard edition.
✔  All emulators ready! It is now safe to connect your app.
```

**Classification: Firestore Emulator REQUIRED, rules file NOT REQUIRED.** No `firestore.rules` file was created at any point in this scope. No top-level `firestore` product key was added to `firebase.json`. The existing `functions/package.json` `deploy` script (already scoped `--only functions`) is unaffected either way.

## 3. Files Included in This Checkpoint

Modified:
- `firebase.json` — adds local-only `emulators.functions` (port 5001) and `emulators.firestore` (port 8080). No rules file, no top-level `firestore` key (per Section 2).
- `kiosk/package.json` / `kiosk/package-lock.json` — adds `build:orderintent-test` esbuild script (mirrors `build:auth-test`) and `firebase-admin` devDependency (Node-side seeding only).

Added:
- `kiosk/browser-test/seedOrderIntentFixtures.js` — Node-side (not browser) seed script using `firebase-admin` against `FIRESTORE_EMULATOR_HOST`. Refuses to run if that env var is unset. Seeds two products + two ingredients under `step89-*` ids.
- `kiosk/browser-test/orderIntentHarness.html` — real Firebase SDK 10.12.2, real `connectAuthEmulator`/`connectFunctionsEmulator`, real bundled `../dist/orderIntentAdapter.js`, real `httpsCallable(functions, "orderIntent")`. The one intentionally CONTROLLED piece is an in-memory fake `persistence` (persistence realness was already proven for real in STEP85 — not this step's job).
- `kiosk/browser-test/orderIntent.browser.spec.js` — Playwright spec, tests D1–D5.

No other file is part of this checkpoint. No locked domain/production file (`kiosk/browser/createBrowserKiosk.js`, `kiosk/auth/firebaseAuthAdapter.js`, `kiosk/host/kioskHost.js`, `kiosk/persistence/persistenceAdapter.js`, `kiosk/persistence/indexedDbAdapter.js`, `kiosk/runtime/*`, `kiosk/session/*`, `kiosk/experience/*`, `kiosk/orderIntent/orderIntentAdapter.js`, `kiosk/orderIntent/orderIntentTypes.js`, `kiosk/orderIntent/orderIntentAdapter.test.js`, any `functions/src/**` file, `functions/index.js`, `.firebaserc`) was modified. `functions/node_modules` was populated via `npm install` (gitignored, no tracked change).

## 4. Verification Results (real, executed this session)

**Emulator suite used:** `firebase emulators:start --only auth,functions,firestore --project demo-orderintent-test` — a `demo-*` project id, never the real `auls-kitchen` project, mirroring STEP87/88's `demo-no-project` safety convention. Confirmed emulator log: `Loaded functions definitions from source: healthCheck, orderIntent, posSale.` — the real, unmodified `functions/src` source.

**New STEP89 spec (`orderIntent.browser.spec.js`, D1–D5):**
- Run #1: **5/5 pass**
- Run #2 (independent invocation): **5/5 pass**

| Test | Result | What it proves |
|---|---|---|
| D1 | PASS | Real success path: real network hit `127.0.0.1:5001`, real `orderState: "VALIDATED"` returned, real Firestore Emulator ingredient stock decremented by exactly the recipe qty (verified via a direct `firebase-admin` read, not the browser). |
| D2 | PASS | Real idempotency-first check in `reservation.js`'s transaction: two calls with the same idempotencyKey both return `SUCCEEDED` with identical `authoritativeResult`, and stock decreases by the recipe qty exactly once, not twice. |
| D3 | PASS | Real `INSUFFICIENT_STOCK` rejection inside the real transaction; ingredient stock verified unchanged (all-or-nothing, zero writes on abort). Also documents a discovered classification defect — see Section 6. |
| D4 | PASS | `authGuard.js` genuinely rejects an unauthenticated call against the running emulator (real `"functions/unauthenticated"` error), not just at the design level. Also documents the same discovered defect. |
| D5 | PASS | Production guard: neither the harness nor the built `dist/orderIntentAdapter.js` artifact contains the literal string `"auls-kitchen"`. |

**Full existing browser regression suite** (`npx playwright test`, all `*.browser.spec.js` together): **56/56 pass** (51 pre-existing — 44 regression + STEP87's 7 + STEP88's 7 — plus the 5 new STEP89 tests). No regression.

**Node domain test suite** (`node --test` over all `kiosk/**/*.test.js`, excluding `browser-test/`): **411/411 pass** — exact match to the STEP87/88-documented baseline. No regression.

## 5. Explicit Claim Boundary

> "Real Functions Emulator verified for `orderIntent`'s success, idempotency-replay, and insufficient-stock paths, running the actual `functions/src` source against a real Firestore Emulator. The adapter's real-vs-controlled error-classification gap for callable errors was discovered and is documented, not fixed, in this scope."

This checkpoint does **NOT** claim: that `orderIntentTypes.js`'s `classifyCallableError` correctly classifies real callable errors (see Section 6 — it does not), that payment/QRIS/Midtrans was exercised, that non-owner-vs-owner Firestore Rules were exercised (Cloud Functions use the Admin SDK, which always bypasses Rules — irrelevant to this scope), or that production Firebase Functions/Firestore were contacted in any way.

## 6. Discovered Defect — Documented, Not Fixed (per explicit scope decision)

**Finding:** the real Firebase Functions client SDK (v10.12.2, modular) returns `err.code` prefixed with `"functions/"` (e.g. `"functions/failed-precondition"`, `"functions/unauthenticated"`), confirmed by direct capture against the real emulator:
```
D3 raw error: {"code":"functions/failed-precondition","message":"...","details":{"code":"INSUFFICIENT_STOCK"}}
D4 raw error: {"code":"functions/unauthenticated","message":"Sign-in is required."}
```
`kiosk/orderIntent/orderIntentTypes.js`'s `classifyCallableError` and its `PROVEN_NO_COMMIT_ERROR_CODES` allowlist (`["invalid-argument", "unauthenticated", "failed-precondition"]`) match only the **bare**, unprefixed code. Against the real SDK this never matches, so every real business rejection and auth rejection currently falls through to the conservative default branch and is classified `UNKNOWN` / `TRANSPORT_UNKNOWN` instead of the intended `REJECTED` / `VALIDATION_REJECTION` or `AUTH_REJECTION`.

**Safety implication:** this is **safe, not silently unsafe** — `UNKNOWN` is the deliberately conservative branch (never fabricates a false success, never silently clears a submission). But it means the adapter's `REJECTED` outcome is currently unreachable against the real backend for callable errors, which affects UX/retry-flow ergonomics (a real business rejection is currently treated the same as "cannot confirm outcome," not as a clean, immediately-actionable rejection).

**Why existing tests never caught this:** `kiosk/orderIntent/orderIntentAdapter.test.js`'s existing unit tests use fake callables that presumably construct errors with bare codes, not real Firebase SDK-shaped ones — this is exactly the category of gap real-vs-controlled verification (STEP89's purpose) exists to surface.

**Decision (explicit, made in this session):** `kiosk/orderIntent/orderIntentTypes.js` is a locked file for this scope. The defect is **documented, not fixed**, per explicit direction. `orderIntent.browser.spec.js`'s D3/D4 assert the real observed `UNKNOWN`/`TRANSPORT_UNKNOWN` behavior (matching reality) rather than the originally-intended `REJECTED` behavior, with inline comments explaining why. A future separate scope should decide how to fix `classifyCallableError`'s code-matching (e.g. strip/accept the `"functions/"` prefix) and re-verify against a real emulator.

## 7. Production Safety

- No production Firebase project (`auls-kitchen`) was contacted at any point — all emulators used `--project demo-orderintent-test`.
- No production Firestore, Auth, or Functions data was read, written, or mutated.
- No production Firestore Rules were modified, read, or deployed.
- No `firestore.rules` file was created (see Section 2).
- No deploy occurred (`firebase deploy` was never run, in any form).
- No push occurred.
- No merge occurred.
- No locked domain/production file was modified (Section 3).
- `.firebaserc` untouched.
- Transient emulator log files (`firebase-debug.log`, `firestore-debug.log`) were deleted, not committed.

## 8. Next Planned Sequence

A. Review this checkpoint commit locally (not pushed).
B. Future separate scope (not started, not authorized by this checkpoint): fix `kiosk/orderIntent/orderIntentTypes.js`'s `classifyCallableError` to correctly match real Firebase Functions client error codes (the `"functions/"` prefix), then re-verify D3/D4 against a real emulator to confirm they now observe `REJECTED` as originally designed.
C. Push to `origin` only after explicit review/approval.

## 9. Checkpoint Closure Statement

STEP 89 (Real Functions Emulator OrderIntent Verification) is verified: the real, unmodified `functions/src` `orderIntent` Cloud Function was exercised end-to-end through the real, unmodified `kiosk/orderIntent/orderIntentAdapter.js`, against a real Firebase Functions Emulator and real Firestore Emulator (no rules file, by observed necessity — Section 2), for success, idempotency-replay, and insufficient-stock paths, with real Firestore stock changes verified directly. Node regression (411/411) and the full existing browser suite (56/56, including the 5 new STEP89 tests) remain green. One real defect in error classification was discovered and is explicitly documented, not fixed, per direction given during this session. No production system was contacted. No locked file was modified.
