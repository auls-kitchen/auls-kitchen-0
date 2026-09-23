# CHECKPOINT — CATALOG PUBLISH INFRASTRUCTURE LIVE

Date: 2026-09-23

## 1. Checkpoint Identity

- Scope name: Catalog Publish Infrastructure Live
- Date: 2026-09-23
- Status: CLOSED — production-live and verified
- PR: #6 `feat(catalog): publish Catalog Snapshot infrastructure`
- PR #6 head before merge: `f12f83ca95c19e4fd74cd256d21e3a8522625e6d`
- Merge commit on `main`: `237f1fd4189f89c516a794fd14a1887aa3cd0323`
- Preceded by: Production Asset Boundary V1 (PR #7, `CHECKPOINT_PRODUCTION_ASSET_BOUNDARY_V1_2026-09-23.md`)

## 2. Scope

This scope took the PR #6 Catalog Publish infrastructure to production and verified it there:

- the Firebase backend (the `catalogPublish` callable)
- Firebase Storage Rules
- the Admin "Publish Katalog" UI, delivered through Cloudflare

It deliberately stops **before** the first real Catalog Snapshot publish.

## 3. Starting State

- PR #6 was opened against `main` at `0373880`, before PR #7 moved the production files into `public/`.
- PR #7 (Production Asset Boundary V1) was merged and live: `wrangler.jsonc` with `assets.directory: ./public`, and exactly 9 public files.
- Firebase at the start (as recorded in the PR #6 Step 2E checkpoint):
  - Deployed Functions were `healthCheck`, `orderIntent`, `posSale`. `catalogPublish` was not deployed.
  - Storage delivery foundation already in place: bucket `auls-kitchen.firebasestorage.app`, Rules, and CORS for `https://kiosk.aulia.fun`.
- Every push to `main` auto-deploys to Cloudflare production at 100% (Workers Builds, `npx wrangler deploy`, no approval gate).
- Firebase has no automated deploy path. It is deployed manually with the CLI.

## 4. PR #6 Implementation

23 files. No AWR files and no Kiosk Domain files.

| Area | Files |
|---|---|
| Domain | `functions/src/domain/catalogValidation.js`, `catalogProjection.js`, `catalogCanonicalization.js`, `catalogRevision.js`, `catalogPublishPlan.js` |
| Callable | `functions/src/functions/catalogPublish.js` (v2 `onCall`, `region: "us-central1"`) |
| Authorization | `functions/src/services/catalogPublishAuthGuard.js` (UID allowlist on top of `requireAuth`) |
| Storage | `functions/src/repositories/catalogStorageRepo.js` |
| Products | `functions/src/repositories/productsRepo.js`: adds read-only `listProducts()`; `getProductById` unchanged |
| Wiring | `functions/index.js` exports `catalogPublish`; `functions/package.json` adds `"test": "node --test"` |
| Firebase config | `storage.rules` (new); `firebase.json` adds `storage.rules` |
| Admin UI | `public/aul-adm.html`: Firebase Functions SDK, `getFunctions(firebaseApp, "us-central1")`, `httpsCallable(functionsInstance, "catalogPublish")`, handler and "Publish Katalog" button |
| Tests | 8 files under `functions/test/` |
| Docs | `CHECKPOINT_STEP2E_STORAGE_DELIVERY_FOUNDATION_2026-09-23.md` |

Reconciliation with PR #7:

- After PR #7 merged, GitHub reported PR #6 as `dirty`. Its check did not follow the `aul-adm.html` → `public/aul-adm.html` rename, although local git did.
- `origin/main` was merged into `catalog-publish-release` with a normal merge (**no rebase, no force-push**), creating commit `f12f83c`.
- The reconciliation merge was **clean**: no conflicts and no manual edits.
- The merged `public/aul-adm.html` is byte-identical to PR #6's intended `aul-adm.html`.
- No root `aul-adm.html` came back, and `public/` still holds exactly 9 files.
- **63/63 tests passed** on the reconciled tree.
- **Wrangler dry-run read exactly 9 files** from `public/`, with no bindings.
- GitHub then reported `clean`, still 23 files (+1826 / −1). PR #6 was merged manually into `main` as `237f1fd`.

## 5. Firebase Production Deployment

User-performed, manual Firebase CLI deploy, limited to the requested targets:

- `catalogPublish` deployed successfully.
- `firebase functions:list` shows `catalogPublish` as a Functions **v2** callable in **us-central1**, runtime **nodejs20**, **256 MB**.
- No other Functions, Hosting, or Firestore rules were part of this deploy.
- `catalogPublish` has **not** been invoked.

## 6. Storage Rules Verification

- The PR #6 `storage.rules` compiled and deployed successfully (`firebase deploy --only storage`).
- Intended rules:
  - `/catalog/**`: `allow read: if true; allow write: if false;`
  - everything else: `allow read, write: if false;`
- Live behaviour (anonymous, read-only probes):
  - list `catalog/`: HTTP 200, empty
  - list bucket root: HTTP 403
  - `catalog/manifest.json`: HTTP 404, meaning it doesn't exist (a denied read would return 403)
- CORS on the bucket (earlier GCS preflight):
  - origin `https://kiosk.aulia.fun`: allowed, methods `GET,HEAD`, headers `Content-Type,ETag`, max-age `3600`
  - any other origin: no allow-origin header
- An anonymous write attempt was intentionally **not** performed.

## 7. Cloudflare Production Deployment

Sources: read-only Cloudflare API (builds, build logs, deployments, versions).

- Workers Build `de2ee864-1bf2-478a-bab8-3a7c87b722e8`
  - Trigger: push to `main`, commit `237f1fd4189f89c516a794fd14a1887aa3cd0323`
  - Created 06:11:31, running 06:11:36, stopped 06:11:55 UTC. Outcome: **success**.
  - Log: "Read 9 files from the assets directory /opt/buildhome/repo/public".
  - Log: only `/aul-adm.html` uploaded (1 new, 8 already uploaded).
  - Log: "Current Version ID: 2e53a2f4-9288-44cd-94ca-dda522c1b1c0".
- Deployment `34023f34-6f87-4f4e-a58c-b3c96d392123`, created 06:11:52 UTC.
- Worker Version **#52** `2e53a2f4-9288-44cd-94ca-dda522c1b1c0`, **100% traffic**.
- Correlation chain:
  - commit → build: exact SHA in the build record
  - build → version: version ID in the build log
  - version → traffic: deployment routes 100% to that version

## 8. Production Asset Boundary

PR #7 remains in force.

- `wrangler.jsonc`: `assets.directory: ./public`, `html_handling: auto-trailing-slash`.
- Served files (exactly 9): `index.html`, `aul-adm.html`, `aul-pos.html`, `customer-display.html`, `manifest-pos.json`, `manifest-cd.json`, `sw.js`, `icon-192.png`, `icon-512.png`.
- Not served: `functions/`, `.git/`, `tools/`, checkpoint files, `storage.rules`, `firebase.json`.

## 9. Browser Verification

User-performed, manual:

- All 9 public URLs work: `/`, `/aul-adm`, `/aul-pos.html`, `/customer-display.html`, `/manifest-pos.json`, `/manifest-cd.json`, `/sw.js`, `/icon-192.png`, `/icon-512.png`.
- All audited internal URLs return 404: `/.git/HEAD`, `/functions/index.js`, `/firebase.json`, `/storage.rules`, `/CHECKPOINT_AWR04_REAL_ANDROID_TOUCH_PERFORMANCE_2026-09-06.md`, `/aul-world-runtime/`, `/tools/`.
- On production `/aul-adm`, the Products tab works and the **Publish Katalog** button is visible.
- The Publish Katalog button has **NOT** been clicked.

## 10. Catalog State

- No Catalog Snapshot has been published. This is intentional.
- `/catalog/` is empty: no `manifest.json` and no `<revision>.json`.
- Storage layout the implementation will create on first publish:
  - `catalog/<revision>.json`: immutable snapshot, written once (`ifGenerationMatch: 0`), `Cache-Control: public, max-age=31536000, immutable`
  - `catalog/manifest.json`: mutable pointer `{ revision, snapshotPath }`, `Cache-Control: no-cache`

## 11. Security / Authority Boundaries

- **Publish authority:** only the `catalogPublish` callable (Admin SDK) writes to `catalog/`. Clients can never write there (`allow write: if false`).
- **Authorization:** `requireCatalogPublishAuthorization` requires authentication, then a single-owner UID allowlist (the UID is not recorded here). Anyone else gets `permission-denied`.
- **Product data:** the backend only reads it (`listProducts()`); the publish path never writes to `products`.
- **Admin UI:** only invokes the callable. It never lists products, computes a revision, or writes Storage.
- **Public read surface:** `/catalog/**` only. Everything else in the bucket is denied.
- **Cloudflare:** serves only the 9 static files in `public/`. Firebase backend code and config are not served.
- **Deploy authority:** Cloudflare deploys automatically from `main`; Firebase is deployed manually with the CLI. They are separate pipelines.

## 12. Verification Evidence

| Item | Evidence | Verified by |
|---|---|---|
| Clean reconciliation, no rebase | Merge `f12f83c` (parents `abc6a3f`, `6828f43`) | git |
| Tests | 63/63 pass on the reconciled tree | `node --test` |
| Asset count | Dry-run read 9 files; production build read 9 files | Wrangler / build log |
| PR #6 merged | `main` = `237f1fd`, second parent `f12f83c` | git / GitHub |
| Cloudflare deploy | Build `de2ee864…` success → version #52 `2e53a2f4…` at 100% | Cloudflare API |
| Admin UI code | `public/aul-adm.html` contains `httpsCallable(functionsInstance, "catalogPublish")` and the "Publish Katalog" button | git (`main`) |
| `catalogPublish` live | v2, us-central1, nodejs20, 256 MB | `firebase functions:list` (user) |
| Storage Rules live | Compiled and deployed; catalog list 200, root 403 | Firebase CLI (user); anonymous probes |
| CORS | Kiosk origin allowed; other origins not | GCS preflight |
| Public / internal URLs | 9 OK / 7 × 404 | Browser (user) |
| No publish happened | `catalog/` empty | Anonymous list |

## 13. Explicitly NOT Done

- First Catalog Snapshot publish
- `catalog/manifest.json` creation
- Kiosk catalog read path
- IndexedDB catalog store
- CDN/cache runtime integration
- Kiosk catalog UX integration
- Anonymous-write denial probe against `/catalog/**`
- No `catalogPublish` invocation, no Product Master changes, no AWR / Kiosk Domain changes

## 14. Known Technical Debt / Follow-up

These are recorded only. Neither is fixed in this checkpoint.

- Node.js 20 deprecation warning (`functions/package.json` `engines.node: "20"`).
- Outdated `firebase-functions` dependency warning (`^5.0.0`).

Other follow-ups:

- `main` has no branch protection, required reviews, or required checks, while every merge deploys to production at 100%.
- The PR #7 checkpoint and this checkpoint live on `claude/cloudflare-mcp-tools-check-xvsmu2` and are not yet on `main`.
- The old branch `catalog-publish-release` is kept (not deleted).

## 15. Next Scope

**FIRST REAL CATALOG PUBLISH.** This is not implementation yet. In order:

1. Inspect the current Product Master data.
2. Run and inspect the projection.
3. Validate the customer-safe payload.
4. Inspect the canonical JSON.
5. Verify the SHA-256 revision calculation.
6. Do a safe preview / dry-run if the implementation supports it.
   - The callable has no dedicated dry-run flag.
   - `runCatalogPublish()` is exported separately with injectable dependencies, which may allow a local preview with no Storage writes. Confirm this before relying on it.
7. Only then, publish the first immutable Catalog Snapshot.
8. Verify `catalog/manifest.json` and `catalog/<revision>.json` live.
9. Do NOT build the Kiosk catalog read path until the published catalog is verified.

## 16. Final Status

**CLOSED — Catalog Publish Infrastructure is production-live and verified. First Catalog Snapshot remains intentionally unpublished.**

CLOSED:

- Catalog Publish backend infrastructure
- Catalog projection / validation / canonicalization / revision infrastructure
- Firebase Storage delivery infrastructure
- Catalog Publish authorization guard
- Production Admin Publish Katalog UI
- Cloudflare public asset boundary
- PR #6 production deployment verification
