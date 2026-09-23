# CHECKPOINT — KIOSK CATALOG CONSUMER FOUNDATION

Date: 2026-09-23

## 1. Checkpoint Identity

- Scope name: Kiosk Catalog Consumer Foundation
- Date: 2026-09-23
- Status: **CLOSED — implemented, reviewed (5/5 audits PASS), committed, pushed**
- Implementation commit: `b48a1a9c379d5023eb0e95a9e5ba5285be4a356c` — `feat(kiosk): catalog consumer foundation`
- Branch: `claude/kiosk-catalog-consumer` (remote `origin/claude/kiosk-catalog-consumer`)
- Parent: `d72ec05` (`origin/step87-auth-browser`)
- Preceded by: `CHECKPOINT_CATALOG_PUBLISH_V1_LIVE_VERIFIED_2026-09-23.md`

## 2. Scope

The Kiosk can now read the Published Product Catalog from public catalog storage, verify its integrity, and keep the last verified catalog in a dedicated IndexedDB store.

This scope did NOT change:

- Kiosk UI or the Aul visuals
- ordering, cart, payment, or POS
- Product Master or Firestore
- the Catalog Publish backend or Storage Rules
- Cloudflare, CDN, or any deployment

**The current Kiosk production experience is unchanged.** The Catalog Consumer Foundation exists as a verified foundation/seam only. It is not wired into `createBrowserKiosk()`, the Kiosk runtime/host, or `aul-world-app/production`.

Branch base decision: the Kiosk code (`kiosk/`, `aul-world-app/`) exists only on `step87-auth-browser`, not on `main`. By explicit decision, this scope was built on a new branch created from `origin/step87-auth-browser`.

## 3. Catalog Authority

The Published Catalog Snapshot is the customer-facing catalog authority for the Kiosk. The Kiosk does not read Product Master from Firestore.

| Item | Value |
|---|---|
| Revision | `1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f` |
| Products | 36 |
| Catalog Publish | LIVE + VERIFIED |
| Manifest | `/catalog/manifest.json` (mutable, `no-cache`) |
| Snapshot | `/catalog/<revision>.json` (immutable) |
| Read endpoint | `https://firebasestorage.googleapis.com/v0/b/auls-kitchen.firebasestorage.app/o/<url-encoded path>?alt=media` |

About the read endpoint: it is public-read under Storage Rules. Bucket CORS allows `https://kiosk.aulia.fun`; this was verified as HTTP 200 with a matching `Access-Control-Allow-Origin` header. The `storage.googleapis.com` forms return 403/401.

The client discovers the revision through the manifest. The revision is never hardcoded.

## 4. Implementation Architecture

```
Published Catalog
    ↓
Manifest
    ↓
Catalog Read Port
    ↓
Snapshot validation
    ↓
Canonicalization
    ↓
SHA-256 integrity verification
    ↓
Verified Catalog
    ↓
kioskCatalog IndexedDB store
    ↓
[NEXT: Kiosk Experience integration]
```

| Module | Responsibility |
|---|---|
| `kiosk/catalog/catalogContract.js` | Manifest, snapshot, and product contract validation; stable error codes |
| `kiosk/catalog/catalogIntegrity.js` | Canonicalize `products` → SHA-256 (WebCrypto) → compare with `revision` |
| `kiosk/catalog/catalogReadPort.js` | Fetch manifest → fetch snapshot → validate → verify. Uses injected `fetch`; no Firebase SDK |
| `kiosk/catalog/catalogIndexedDbStore.js` | Dedicated `kioskCatalog` object store |
| `kiosk/catalog/catalogService.js` | Manifest → revision → verified-cache flow and fallback; one load in flight at a time |
| `kiosk/catalog/createBrowserCatalog.js` | Browser factory: the seam for the next scope |
| `kiosk/persistence/kioskDbSchema.js` | Shared database name, version 2, and the additive store upgrade |

Implemented:

1. Catalog contract validation
2. Catalog integrity verification
3. Catalog Read Port
4. Manifest → snapshot flow
5. SHA-256 verification using the existing publisher canonicalization algorithm
6. Dedicated IndexedDB catalog store
7. IndexedDB schema version 2
8. v1 → v2 additive migration
9. Catalog revision/cache handling
10. Last-verified-cache offline fallback
11. Browser factory seam for the next scope
12. Browser tests and live catalog verification

The manifest's `snapshotPath` must equal `/catalog/<its own revision>.json` exactly. Anything else is rejected.

**Strict V1 contract.** Only these fields are accepted; any other key rejects the whole snapshot:

- Product: `productId, name, category, categoryLabel, categoryOrder, itemOrder, price, imageUrl?, modifierGroups?`
- Modifier group: `id, name, selectionType, required, options`
- Option: `id, name, price, isDefault`

These field sets were audited as identical to the publisher projection and to the live V1 snapshot. `imageUrl` is kept when present and stays absent when absent.

## 5. IndexedDB Migration

| Item | Value |
|---|---|
| Database | `aulKitchenKiosk` |
| Version | **2** (was 1) |
| Stores | `kioskPersistence`, `kioskCatalog` |
| Catalog record key | `verifiedCatalog` → `{ schemaVersion: 1, revision, products, verifiedAt }` |

- The v1 → v2 upgrade is additive and idempotent. It creates a store only if it is missing, and it never deletes or clears one.
- Existing `kioskPersistence` data is preserved. This was verified in the browser: a v1 record came back identical after the upgrade.
- The old persistence adapter and the catalog store use the same version constant and the same upgrade function, so opening them cannot produce a version mismatch.
- The catalog record:
  - is not keyed by `ownerUid`;
  - is independent of customer context;
  - is not deleted by customer-context reset, which only deletes the `kioskCustomerContext` key in `kioskPersistence` (verified in the browser);
  - is written in a single transaction and resolves on `oncomplete`;
  - is persisted only after successful verification.
- **Downgrade constraint:** once a device has opened version 2, an older version-1 Kiosk cannot reopen the database without clearing IndexedDB. No downgrade support was added.

## 6. Cache / Offline Policy (LOCKED)

**SERVE LAST VERIFIED CACHE.**

| Situation | Result |
|---|---|
| Manifest revision matches the verified local catalog | `CURRENT` (`source: "cache"`); no snapshot download |
| New revision | Download → verify → persist → `CURRENT` (`source: "network"`) |
| Network/manifest (or snapshot) failure, verified cache present | `STALE` + reason code; last verified catalog returned |
| Network/manifest failure, no verified cache | `UNAVAILABLE` + reason code |
| Failed verification | Never replaces the previous valid catalog; nothing is persisted |
| Corrupted local catalog | Re-verified (structure + SHA-256) before use; if invalid, it is not trusted |
| IndexedDB write failure | Verified catalog still returned with `persisted: false`; the previous record is untouched |

## 7. Integrity Verification

The Kiosk does **NOT** hash raw snapshot bytes. Verification is:

```
snapshot.products
  → existing catalogCanonicalization (functions/src/domain/catalogCanonicalization.js)
  → SHA-256 (WebCrypto)
  → compare with snapshot.revision
```

- The canonicalization implementation is shared with the publisher: one algorithm.
- Browser bundle audit (esbuild metafile): the bundle's 8 inputs are the 7 `kiosk/` modules plus `catalogCanonicalization.js`.
  - `catalogCanonicalization.js` has zero imports.
  - The bundle contains no Firebase Admin, Firestore, Storage SDK, Node filesystem API, or unrelated backend module; a string scan counted 0 occurrences.

## 8. Test Results

| Suite | Result |
|---|---|
| Catalog unit tests | 33/33 PASS |
| All Kiosk Node tests | 483/483 PASS |
| Catalog browser tests (G, H+L, I+K, LIVE) | 4/4 PASS |
| Functions tests | 63/63 PASS |
| AUL World App tests | 318/318 PASS |
| Typecheck | PASS |
| Production build (`aul-world-app build:prod`) | PASS |
| `git diff --check` | PASS |

Emulator-dependent browser specs:

- 8 failures: `authAdapter` A1–A20 (6 tests), `composition` C1–C4, and `orderIntent` D1.
- The same 8 failures reproduce on untouched `origin/step87-auth-browser`, with 1 passed and 10 did-not-run in both runs.
- Cause: the Firebase Auth/Functions emulators are unavailable in this environment. No regression is attributed to this scope.

`aul-world-app verify:frozen` flags uncommitted `kiosk/` changes by design. It compares against HEAD, so it is satisfied once the change is committed.

## 9. Live Verification (Catalog V1, read-only)

In real Chromium, with real IndexedDB and real WebCrypto:

- Manifest fetched from live Firebase Storage (HTTP 200, `application/json`).
- Snapshot fetched (HTTP 200, `application/json`).
- Revision verified: `1b839d2f…6f48f`.
- 36 products accepted.
- Persisted to the dedicated IndexedDB store (`persisted: true`).
- Reload recovery verified: `CURRENT` from cache, same 36 product IDs, only the manifest re-requested.

The test origin is `127.0.0.1`, which bucket CORS does not allow. So the real Storage responses were fetched on the Node side (`route.fetch()`) and passed to the page unmodified, apart from an `Access-Control-Allow-Origin` header.

The same flow was also verified from Node with the real read port.

No Product Master write, no Storage write, no publish.

## 10. Android Status

**NOT VERIFIED.**

Physical Android verification is still open:

- `kiosk.aulia.fun` is not yet deployed.
- The production Kiosk entry is not wired to this catalog layer.

The target is still Android 7.1+ on low-resource tablets (known device: Advan Tab A10). Items to check on the device:

- `crypto.subtle` availability (requires a secure context)
- `AbortController` (the timeout is optional when it is absent)
- IndexedDB behavior

## 11. Known Non-Blocking Concerns

1. **Publisher validation edge cases** (outside this scope):
   - a non-numeric `itemOrder` would be published as `null`;
   - a blank or non-string `imageUrl` would be copied as-is.

   The consumer rejects both, so Kiosks would serve `STALE`. Neither occurs in current data.
2. **IndexedDB downgrade constraint:** a version-1 build cannot open the version-2 database without clearing IndexedDB.
3. **Possible blocked upgrade** if an old tab holds version 1 open. `onblocked` is not handled. This is unlikely for a single-page Kiosk.
4. **Strict V1 contract:** consumer compatibility must ship before the publisher sends a new customer-safe field.
5. **Android physical verification** is still pending.
6. **The catalog is NOT yet wired** into the Kiosk UI/runtime.

Also noted:

- The production bundle already includes the v2 schema through `createBrowserKiosk` → `indexedDbAdapter`, so the next production Kiosk run will create `kioskCatalog` (an additive change).
- This branch predates `main`'s PR #7 `public/` layout and carries its own copies of the catalog commits. Bringing the Kiosk to `main` later requires its own reconciliation.

## 12. Exact Commit / Branch State

| Item | Value |
|---|---|
| Implementation commit | `b48a1a9c379d5023eb0e95a9e5ba5285be4a356c` |
| Message | `feat(kiosk): catalog consumer foundation` |
| Branch | `claude/kiosk-catalog-consumer` |
| Remote | `origin/claude/kiosk-catalog-consumer` (synchronized) |
| Working tree at implementation commit | clean |
| Diff | 17 files, +1492 / −9, all under `kiosk/` |

Files in the implementation commit (exactly the 17 reviewed):

- Modified:
  - `kiosk/package.json` (adds `build:catalog-test`)
  - `kiosk/persistence/indexedDbAdapter.js`
  - `kiosk/persistence/persistenceAdapter.test.js` (the import allowlist adds `./kioskDbSchema`, which the guard also scans)
- Added:
  - `kiosk/persistence/kioskDbSchema.js`
  - `kiosk/catalog/catalogContract.js`
  - `kiosk/catalog/catalogIntegrity.js`
  - `kiosk/catalog/catalogReadPort.js`
  - `kiosk/catalog/catalogIndexedDbStore.js`
  - `kiosk/catalog/catalogService.js`
  - `kiosk/catalog/createBrowserCatalog.js`
  - `kiosk/catalog/catalogContract.test.js`
  - `kiosk/catalog/catalogIntegrity.test.js`
  - `kiosk/catalog/catalogService.test.js`
  - `kiosk/catalog/fixtures/catalogV1Manifest.json`
  - `kiosk/catalog/fixtures/catalogV1Snapshot.json`
  - `kiosk/browser-test/catalog.browser.spec.js`
  - `kiosk/browser-test/catalogHarness.html`

Not merged to `main`. No PR.

## 13. Next Scope Boundary

**NEXT SCOPE ONLY: "Kiosk Catalog → Experience Integration"**

That future scope may address:

- connecting the verified catalog service (`createBrowserCatalog().loadCatalog()`) to the Kiosk experience
- replacing the appropriate catalog data source
- mapping published catalog products into the existing customer journey
- preserving the current AWR/UI foundation
- handling catalog loading states (`CURRENT` / `STALE` / `UNAVAILABLE`) within the existing experience

**None of this is implemented in this checkpoint.**

The current Kiosk production experience remains unchanged. The Catalog Consumer Foundation exists as a verified foundation/seam only.
