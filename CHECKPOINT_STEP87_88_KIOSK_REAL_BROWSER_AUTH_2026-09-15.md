# CHECKPOINT — STEP 87 + STEP 88: KIOSK REAL BROWSER AUTH/COMPOSITION VERIFICATION

Date: 2026-09-15

## 1. Checkpoint Identity

- Scope name: Kiosk Real Browser Auth + Composition Verification (STEP 87, STEP 88)
- Branch: `step87-auth-browser`
- HEAD before this checkpoint: `594fa15680d1f0544f3ebe01abc8b3830defe647` ("Add Kiosk IndexedDB browser persistence verification (STEP 85)")
- STEP 87 status: VERIFIED
- STEP 88 status: PASS / CLOSED
- Remote status: NOT PUSHED

## 2. Environment (local AUL Workstation, verified this session)

- OS: Windows 10 Pro 10.0.19045
- Git: 2.55.0.windows.5
- Node: v24.21.0
- npm: 11.19.0
- Java: OpenJDK Temurin 21.0.12.1+1 LTS
- Firebase CLI: 15.30.0 (`C:\Users\Yayan Jaya\AppData\Roaming\npm\firebase`)
- Playwright/Chromium: `@playwright/test` ^1.56.1 installed in `kiosk/node_modules`; Chromium `chromium-1194` present under `%LOCALAPPDATA%\ms-playwright` and used via `playwright.chromium.executablePath()`

## 3. Files Included in This Checkpoint

Modified (STEP 87):
- `firebase.json` — adds local-only `emulators.auth` config (port 9099, UI disabled, `singleProjectMode: true`); `functions.source` unchanged
- `kiosk/package.json` — adds `build:auth-test` esbuild script
- `kiosk/playwright.config.js` — Chromium `executablePath` now resolved via `playwright.chromium.executablePath()` instead of a hardcoded path

Added (STEP 87):
- `kiosk/browser-test/authHarness.html`
- `kiosk/browser-test/authAdapter.browser.spec.js`

Added (STEP 88):
- `kiosk/browser-test/compositionHarness.html`
- `kiosk/browser-test/composition.browser.spec.js`

No other file is part of this checkpoint. No locked domain/production file (`kiosk/browser/createBrowserKiosk.js`, `kiosk/auth/firebaseAuthAdapter.js`, `kiosk/host/kioskHost.js`, `kiosk/persistence/persistenceAdapter.js`, `kiosk/persistence/indexedDbAdapter.js`, `kiosk/runtime/*`, `kiosk/session/*`, `kiosk/orderIntent/*`, `kiosk/experience/*`) was modified.

## 4. Verification Results

**Node test suite (regression, unchanged):** 411/411 pass, 0 fail — before and after STEP 88 implementation.

**Existing browser suite (regression, unchanged):** 44/44 pass — `kioskHarness.browser.spec.js` (B1–B11, fake-Firebase composition), `persistence.browser.spec.js` (P1–P16, H1–H5, real IndexedDB in isolation).

**STEP 87 — Firebase Auth Emulator browser verification (`authAdapter.browser.spec.js`, A1–A22):**
- Run #1: 7/7 pass
- Run #2 (independent invocation): 7/7 pass
- Real Firebase SDK 10.12.2 + real Firebase Auth Emulator (`127.0.0.1:9099`) + real `firebaseAuthAdapter` verified: anonymous sign-in, UID stability, Auth Reset identity rotation, concurrent-call dedup, public-surface isolation (no raw Auth/User exposed).

**STEP 88 — Real Browser Composition Verification (`composition.browser.spec.js`, C1–C22):**
- Run #1: 7/7 pass (combined suite: 51/51 pass)
- Run #2 (independent invocation): 7/7 pass (combined suite: 51/51 pass)
- Real Firebase SDK + real Firebase Auth Emulator + real native browser IndexedDB + the actual, unmodified generated `createBrowserKiosk()` artifact + actual Kiosk Host + actual Runtime/Experience composition verified end-to-end: `host.beginCustomerSession()` → real Auth Adapter → real Emulator UID → real Runtime `hydrate()` → real IndexedDB read-back, reaching `READY` only on genuine hydrate success.

**Network isolation:** Verified by hostname-based allowlist (`127.0.0.1`, `localhost`, `www.gstatic.com`), evaluated against `URL.hostname` (never a raw-URL substring match, which would misclassify the Auth Emulator's own `identitytoolkit.googleapis.com` request *path* as external). Zero non-allowlisted requests observed in either step.

**Production safety:** Production Firebase project, Auth, Functions, and Firestore were NOT contacted. Both harnesses use only a synthetic `demo-no-project` config, never `.firebaserc`'s real project id (`auls-kitchen`) — confirmed by source scan.

**Artifact hygiene:** `kiosk/dist/createBrowserKiosk.js` and `kiosk/dist/firebaseAuthAdapter.js` scanned and confirmed free of `gstatic`/`firebasejs`/`firebase-*`/`firestore`/`midtrans`/`qris`/other forbidden runtime dependencies. `kiosk/dist/*` remains gitignored, never tracked.

**Git hygiene:** `git diff --check` clean (exit 0) both before and after implementation. No stray `firebase-debug.log`, `node_modules`, `dist`, or `test-results` staged.

## 5. Explicit Claim Boundary

> "Real Browser Composition verified with real Firebase Auth Emulator and real IndexedDB; OrderIntent/Functions backend remained intentionally outside this scope."

This checkpoint does **NOT** claim: production Firebase verification, Firebase Functions backend verification, OrderIntent backend verification, payment verification, or QRIS/Midtrans verification. The `httpsCallable`/OrderIntent seam was deliberately CONTROLLED in both harnesses — constructed but never invoked, never a real network request.

## 6. Production Safety

- No production Auth, Firestore, or Functions contacted.
- No production data read, written, or mutated.
- No production Rules modified.
- No deploy.
- No push.
- No PR opened.
- No merge.
- No locked Kiosk domain/production file modified.

## 7. Working Tree at Checkpoint

Standing state immediately before this checkpoint file was added (identical to the STEP 87/88 diff audited throughout both steps):
```
 M firebase.json
 M kiosk/package.json
 M kiosk/playwright.config.js
?? kiosk/browser-test/authAdapter.browser.spec.js
?? kiosk/browser-test/authHarness.html
?? kiosk/browser-test/composition.browser.spec.js
?? kiosk/browser-test/compositionHarness.html
```

## 8. Next Planned Sequence

A. Review this checkpoint commit locally (not pushed).
B. Future separate scope (not started, not authorized by this checkpoint): a STEP 89-equivalent "Real Functions Emulator OrderIntent Verification" — the one remaining REAL vs CONTROLLED boundary, verifying `httpsCallable("orderIntent")` against a real Firebase Functions Emulator running the actual `functions/` source, scoped the same way (Functions Emulator only, locked-files list re-applied, fresh-inspection/fail-closed discipline).
C. Push to `origin` only after explicit review/approval.

## 9. Checkpoint Closure Statement

STEP 87 (Firebase Auth Emulator browser verification) and STEP 88 (Real Browser Composition Verification) are both verified locally with real Chromium, real Firebase Auth Emulator, real native IndexedDB, and the actual unmodified `createBrowserKiosk()`/Host/Runtime composition. No production system was contacted. No locked file was modified. Node regression (411/411) and the pre-existing browser suite (44/44) remain green. OrderIntent/Functions backend verification remains explicitly out of scope for a future checkpoint.
