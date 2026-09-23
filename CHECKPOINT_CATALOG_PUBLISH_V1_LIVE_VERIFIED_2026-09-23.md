# CHECKPOINT — CATALOG PUBLISH V1 LIVE & VERIFIED

Date: 2026-09-23

## 1. Checkpoint Identity

- Scope name: Catalog Publish V1 — First Real Publish
- Date: 2026-09-23
- Status: **CLOSED — LIVE & VERIFIED**
- Final catalog revision: `1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f`
- Code on `main`: `237f1fd4189f89c516a794fd14a1887aa3cd0323`. Catalog Publish infrastructure (PR #6) is unchanged by this scope.
- Preceded by: `CHECKPOINT_CATALOG_PUBLISH_INFRASTRUCTURE_LIVE_2026-09-23.md`

## 2. Scope

This scope took the first real Catalog Snapshot from preview to live:

- Phase 1: read-only inspection of the implementation and of the real Product Master; zero-write preview with `buildCatalogPublishPlan()`.
- Phase 1B: removed two confirmed dummy products from Product Master. The owner did this through the Admin UI.
- Phase 1C: re-ran the preview on the cleaned 36-product Product Master.
- Phase 2: the owner ran one real publish through the deployed `catalogPublish` callable (Admin UI "Publish Katalog"). Post-publish verification was read-only.

No implementation, Storage Rules, Cloudflare, Kiosk, or IndexedDB changes were made.

## 3. Product Master State

- **36 products.**
- Both dummy products were deleted and verified absent (HTTP 404 by exact document ID):
  - `afjuzXhM2UbGpBmLiPAh` — "Strada" (category `Milk`, not a Category Master id)
  - `BNN0ccA4K4YDTvUe56Dd` — "Test" (milky, Rp 1,000)
- The remaining 36 products were compared field-by-field with the pre-cleanup read. They were unchanged.
- Validation: **36/36 PASS**, **0 fatal errors**.
- Products per category:
  - coffee 8
  - milky 4
  - soda 5
  - blend 5
  - tea 4
  - cooler 4
  - choco 6
- Every product's `category` / `categoryLabel` / `categoryOrder` matches Category Master.
- No duplicate `categoryOrder|itemOrder` pairs, and no product falls back to the default `itemOrder`.

## 4. Final Catalog Revision

```
1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f
```

- Computed as SHA-256 over the canonical JSON `{"products":[...]}` (5,975 bytes).
- Confirmed by `buildCatalogPublishPlan()`, by independent re-canonicalization, and by `sha256sum`.
- Re-confirmed in the pre-publish guard immediately before publishing. The callable returned the same revision.

## 5. Manifest

- Path: `/catalog/manifest.json`
- Content (verified exact, keys `revision` and `snapshotPath` only):

```json
{"revision":"1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f","snapshotPath":"/catalog/1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f.json"}
```

## 6. Snapshot

- Path: `/catalog/1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f.json`
- Structure: `{"revision": "<sha256>", "products": [ ...36 customer-safe products... ]}`

## 7. Publish Result

- Invoked once by the owner via the production Admin UI (`/aul-adm` → Produk → Publish Katalog). This calls the deployed callable `catalogPublish` (v2, us-central1).
- Returned revision: `1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f`, which matches the preview.
- Product count: 36.
- There were no retries and no second publish.

## 8. Verification Result

Every check below used anonymous GET requests only (Firebase Storage REST).

| # | Check | Result |
|---|---|---|
| 1 | Manifest exists | PASS |
| 2 | Snapshot exists | PASS |
| 3 | Manifest revision matches final revision | PASS |
| 4 | Manifest `snapshotPath` matches exact snapshot | PASS |
| 5 | Snapshot contains 36 products (and its `revision` matches) | PASS |
| 6 | Forbidden internal fields absent (recipe, ingredient, stock, cost, HPP, availability) | PASS |
| 7 | Snapshot products re-canonicalized with the existing code, then SHA-256 independently recomputed = revision (`snapshotVerifiable = true`) | PASS |
| 8 | Public anonymous GET of the manifest: HTTP 200, `application/json` | PASS |
| 9 | Public anonymous GET of the snapshot: HTTP 200, `application/json` | PASS |
| 10 | Snapshot immutability and security semantics | PASS |

In addition:

- The published snapshot is **byte-for-byte identical** to the preview artifact produced by the pre-publish guard.
- `catalog/` lists exactly two objects: the manifest and this snapshot.

## 9. Storage Metadata

| | Manifest | Snapshot |
|---|---|---|
| Size | 175 bytes | 6,053 bytes |
| Content-Type | `application/json` | `application/json` |
| Cache-Control | `no-cache` | `public, max-age=31536000, immutable` |
| generation | `1790154198723747` | `1790154197276717` |
| metageneration | 2 | 2 |
| timeCreated | 2026-09-23T09:03:18.727Z | 2026-09-23T09:03:17.282Z |

The snapshot was created before the manifest, as the publish sequence requires: snapshot first, then the manifest flip.

## 10. Security State

- `/catalog/**` is publicly readable (anonymous list and GET return 200).
- `/catalog/**` client writes are denied by Storage Rules (`allow write: if false`). Everything outside `catalog/` is denied to clients.
- Snapshot creation uses `preconditionOpts: { ifGenerationMatch: 0 }`. An existing snapshot is never overwritten by a normal publish; a 412 is treated as idempotent success.
- The manifest is the single mutable pointer (`no-cache`). The snapshot is immutable and long-cacheable.
- Only the owner-allowlisted `catalogPublish` callable (Admin SDK) writes catalog objects.
- **No destructive or write test was performed after publish.**

## 11. Known Notes / Non-Blocking Warnings

1. **metageneration = 2 on both objects.** `updated` is about 60–70 s after `timeCreated`, while `generation` and the content stayed unchanged; the snapshot bytes are still identical to the preview. This is treated as a metadata-only mutation, consistent with the objects being opened in the Firebase console.
2. **Snapshot bytes are not the canonical JSON.** The snapshot is serialized as `JSON.stringify({ revision, products })`, with `revision` first and projection key order preserved. The revision is calculated over the canonical `{"products":[...]}` (alphabetized keys). Therefore:
   - Catalog consumers **MUST** canonicalize `snapshot.products` (same rules as `catalogCanonicalization.js`) before SHA-256 verification.
   - Consumers **MUST NOT** hash the raw snapshot bytes and compare that hash to `revision`.
3. **Images.** Only 1 of 36 products has `imageUrl` (`coffee__ori-ala-aul`, Cloudinary). This is a content/data completeness issue, not a Catalog Publish V1 validation failure.
4. **Unused category.** Category Master contains `blueelectric` (order 9) with no products. This is not a publish failure; it simply does not appear in the catalog.
5. The only modifier group in the catalog is "Sugar Level" on `coffee__ori-ala-aul`.

## 12. Previous Unpublished Revision

- The 38-product preview revision `df28fe1069917e5e522f0c0243f50693527ab426bd311ed283dbe12fbd2914ed` (it included the two dummy products) was **never published**.
- The 36-product canonical JSON equals the 38-product canonical JSON with those two products removed. The revision change comes only from the cleanup.
- `catalog/` currently contains only `manifest.json` and the final immutable snapshot.

## 13. Architecture Position

```
Product Master
→ Customer-safe Projection
→ Catalog Publish
→ Immutable Catalog Snapshot
→ Firebase Storage
→ Manifest
→ [NEXT: Tablet Catalog Read Port]
→ IndexedDB Catalog Store
→ Kiosk Experience
```

Everything up to and including **Manifest** is live and verified.

## 14. Next Scope Boundary

**NEXT SCOPE ONLY: "Kiosk Catalog Consumer Foundation"**

Expected next work:

- manifest read
- snapshot read
- integrity verification (re-canonicalize `products`, then SHA-256; see §11.2)
- Catalog Read Port
- dedicated IndexedDB catalog object store
- cache/revision handling

**None of this is implemented or started in this checkpoint.**

## 15. Final Status

**CLOSED — Catalog Publish V1 is LIVE & VERIFIED.**

The final revision `1b839d2f9c9b0a58f5c067109675464cdaf24a43c0fbb73a2a98bd130ab6f48f` is published, publicly readable, integrity-verified, and protected by immutable-snapshot semantics.
