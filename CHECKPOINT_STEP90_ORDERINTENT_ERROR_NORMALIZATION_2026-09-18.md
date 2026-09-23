# CHECKPOINT — STEP 90: ORDERINTENT CALLABLE ERROR-CODE NORMALIZATION FIX

Date: 2026-09-18

## 1. Checkpoint Identity

- Scope name: OrderIntent Callable Error-Code Normalization Fix (STEP 90)
- Branch: `step87-auth-browser`
- HEAD before this checkpoint: `1766e0aa6a00e67316c8548f80505312cffe9166` ("Add STEP89: real Firebase Functions Emulator verification for orderIntent")
- STEP 90 status: **VERIFIED — defect fixed and confirmed against the real Functions Emulator**
- Remote status: NOT PUSHED

This closes the exact defect discovered and documented (not fixed) in `CHECKPOINT_STEP89_ORDERINTENT_FUNCTIONS_EMULATOR_2026-09-18.md` Section 6, per explicit Guru approval of the STEP90 discovery report.

## 2. The Fix

**File:** `kiosk/orderIntent/orderIntentTypes.js` — function `classifyCallableError(err)` only.

**Change:** a single normalization step added at the top of the function: a leading `"functions/"` prefix is stripped from `err.code` before every existing comparison (`PROVEN_NO_COMMIT_ERROR_CODES.includes(code)`, `code === "unauthenticated"`, `code === "invalid-argument"`). No change to `PROVEN_NO_COMMIT_ERROR_CODES`'s contents. No change to the `businessCode`/`category`/`reason` derivation logic beyond reusing the now-normalized `code` variable it already used.

```diff
 function classifyCallableError(err) {
-  const code = err && typeof err.code === "string" ? err.code : null;
+  const rawCode = err && typeof err.code === "string" ? err.code : null;
+  const FUNCTIONS_CODE_PREFIX = "functions/";
+  const code =
+    rawCode && rawCode.startsWith(FUNCTIONS_CODE_PREFIX)
+      ? rawCode.slice(FUNCTIONS_CODE_PREFIX.length)
+      : rawCode;
```

## 3. Files Changed (exactly the pre-approved scope, nothing else)

- `kiosk/orderIntent/orderIntentTypes.js` — the fix (Section 2).
- `kiosk/orderIntent/orderIntentAdapter.test.js` — 7 new regression tests added (D16-D20, E22-E23); all pre-existing tests unchanged.
- `kiosk/browser-test/orderIntent.browser.spec.js` — only D3 and D4's bodies/comments updated to assert the now-correct `REJECTED` outcome; D1, D2, D5 untouched.

**Not modified (explicit exclusions, all honored):** `functions/src/**`, `functions/index.js`, Firestore rules/config (no `firestore.rules` file exists or was added — unchanged from STEP89), the Auth adapter, `kiosk/orderIntent/orderIntentAdapter.js`, any runtime/session/experience/persistence/host/browser architecture file, payment/Midtrans/QRIS code, production Firebase configuration, `.firebaserc`.

## 4. New Regression Tests (Node, `orderIntentAdapter.test.js`)

| Test | Fixture | Asserts |
|---|---|---|
| D16 | `{code:"functions/failed-precondition", details:{code:"INSUFFICIENT_STOCK"}}` | `REJECTED` / `VALIDATION_REJECTION` / `"INSUFFICIENT_STOCK"` |
| D17 | `{code:"functions/unauthenticated"}` | `REJECTED` / `AUTH_REJECTION` / `"AUTH_REQUIRED"` |
| D18 | `{code:"functions/invalid-argument"}` | `REJECTED` / `VALIDATION_REJECTION` / `"INVALID_REQUEST_SHAPE"` |
| D19 | bare `{code:"unauthenticated"}` | still `REJECTED` — normalization preserves backward compatibility with existing bare-code fixtures |
| D20 | all three prefixed codes above | none ever produce `SUCCEEDED` (explicit no-false-success assertion) |
| E22 | `{code:"functions/internal"}` | still `UNKNOWN` / `INTERNAL_UNKNOWN` — normalization does not widen the allowlist |
| E23 | `{code:"functions/unavailable"}` (prefixed, unrecognized) | still `UNKNOWN` / `TRANSPORT_UNKNOWN` — safe fallback preserved for prefixed-but-unlisted codes too |

## 5. Verification Results (real, executed this session)

**Node regression suite** (`node --test` over all `kiosk/**/*.test.js`, excluding `browser-test/`): **418/418 pass** (411 pre-existing baseline + 7 new STEP90 tests, exact arithmetic match, 0 failures).

**Real emulator stack** (`firebase emulators:start --only auth,functions,firestore --project demo-orderintent-test`) — confirmed ready, real `orderIntent` loaded from `functions/src`:
```
+  functions[us-central1-orderIntent]: http function initialized (http://127.0.0.1:5001/demo-orderintent-test/us-central1/orderIntent).
✔  All emulators ready! It is now safe to connect your app.
```

**Updated `orderIntent.browser.spec.js` (D1-D5) against the real emulator:**
- Run #1: **5/5 pass**
- Run #2 (independent invocation): **5/5 pass**
- D3 now observed: `outcome: "REJECTED"`, `category: "VALIDATION_REJECTION"`, `reason: "INSUFFICIENT_STOCK"` — corrected from STEP89's observed `UNKNOWN`/`TRANSPORT_UNKNOWN`, with the real raw error still `{"code":"functions/failed-precondition","details":{"code":"INSUFFICIENT_STOCK"}}`.
- D4 now observed: `outcome: "REJECTED"`, `category: "AUTH_REJECTION"`, `reason: "AUTH_REQUIRED"` — corrected from STEP89's observed `UNKNOWN`/`TRANSPORT_UNKNOWN`, real raw error still `{"code":"functions/unauthenticated"}`.
- D1, D2, D5 unchanged in behavior and assertions (real success path, idempotency replay, production guard) — all still pass exactly as in STEP89.

**Full browser regression suite** (`npx playwright test`, all `*.browser.spec.js`): **56/56 pass** — identical count to the STEP89 baseline (no new browser test files or test blocks were added in STEP90, only D3/D4 bodies updated).

**Production-network isolation:** confirmed via the already-passing D1 host-allowlist assertions (`127.0.0.1`, `localhost`, `www.gstatic.com` only, explicit forbidden-pattern checks for `cloudfunctions.net`/`googleapis.com`/`midtrans`/`qris`) and D5's production-guard scan (neither the harness nor the built `dist/orderIntentAdapter.js` artifact contains the literal string `"auls-kitchen"`).

## 6. Cleanup Evidence

Emulator processes stopped and verified by direct port/process inspection (not merely assumed from a stop command):
- `127.0.0.1:9099` (Auth) — not listening
- `127.0.0.1:5001` (Functions) — not listening
- `127.0.0.1:8080` (Firestore) — not listening
- Process scan for any `node.exe`/`java.exe` referencing `firebase`/`emulator` in its command line — none found
- Both the firebase CLI process and its orphaned Firestore-emulator Java child (Windows does not cascade-kill child processes) were confirmed stopped individually by PID.
- Transient `firebase-debug.log`/`firestore-debug.log` deleted, not committed.

## 7. Git Diff Discipline

`git diff --check`: clean (no whitespace errors). `git status --porcelain` before staging showed exactly the three pre-approved files modified, nothing else:
```
 M kiosk/browser-test/orderIntent.browser.spec.js
 M kiosk/orderIntent/orderIntentAdapter.test.js
 M kiosk/orderIntent/orderIntentTypes.js
```

## 8. Explicit Claim Boundary

> "The real-vs-controlled error-classification defect discovered in STEP89 is fixed by a single normalization step in `classifyCallableError`, confirmed against the real Functions Emulator for both `functions/failed-precondition` and `functions/unauthenticated`, with backward compatibility for existing bare-code fixtures and no widening of the UNKNOWN safety fallback."

This checkpoint does **NOT** claim: any change to the backend contract, any change to Firestore Rules or their necessity classification (unchanged from STEP89 — still no rules file, still not required), any change to payment/QRIS/Midtrans, or that production Firebase was contacted in any way.

## 9. Production Safety

- No production Firebase project (`auls-kitchen`) was contacted — emulator suite used `--project demo-orderintent-test` throughout.
- No production Firestore, Auth, or Functions data was read, written, or mutated.
- No deploy occurred.
- No push occurred.
- No merge occurred.
- No amendment of the STEP89 commit (`1766e0a`) — this is a new, separate commit.
- No file outside the three pre-approved files was modified.
- No scope expansion occurred; no unrelated defect surfaced during this work.

## 10. Checkpoint Closure Statement

STEP 90 (OrderIntent Callable Error-Code Normalization Fix) is verified: the exact defect discovered in STEP89 — real Firebase Functions client SDK error codes being prefixed `"functions/"` while the classifier matched only bare codes — is fixed with a single, minimal normalization change in `kiosk/orderIntent/orderIntentTypes.js`'s `classifyCallableError`. Node regression is 418/418 (411 + 7 new). The real Functions Emulator confirms D3 and D4 now correctly classify as `REJECTED` (previously `UNKNOWN`), with D1/D2/D5 unchanged, across two independent runs. The full browser suite remains 56/56. All emulator processes were stopped and verified stopped by direct port/process inspection. No production system was contacted. No file outside the approved scope was touched.
