# AUL'S KITCHEN
## STEP 2E — STORAGE DELIVERY FOUNDATION CHECKPOINT

Date:
2026-09-23

---

### 1. Repository baseline

- Previous HEAD: `b83fecbbd6c1a7633ab62edc6f39d48f7374dd74`
  ("feat(kiosk): checkpoint production experience shell")
- Branch: `step87-auth-browser`
- Expected pre-checkpoint working tree:
  ```
   M firebase.json
  ?? storage.rules
  ```
- Files introduced/modified by this checkpoint:
  - `firebase.json` — modified (additive `storage` key)
  - `storage.rules` — new file
  - `CHECKPOINT_STEP2E_STORAGE_DELIVERY_FOUNDATION_2026-09-23.md` — new file (this document)

No other file was touched by Steps 2C, 2D, or 2E. All temporary probe
functions and their source files created during those steps were fully
removed before this checkpoint (see Section 8).

---

### 2. Architecture decision

The selected Catalog delivery architecture:

```
Product Master
  → (future) customer-safe projection
  → (future) Catalog Publish
  → Firebase Storage
  → /catalog/manifest.json
  → /catalog/<sha256>.json
  → browser/tablet
  → (future) https://kiosk.aulia.fun
```

**Firebase Storage is the selected immutable Catalog delivery backend.**
Firebase Hosting was investigated earlier (Step 2 discovery) and found to
have no evidenced deploy path from a Cloud Function and no evidenced
immutable-revision retention — it is **not** the active or planned
Catalog delivery backend. This checkpoint does not use, configure, or
imply Firebase Hosting for Catalog delivery in any way.

---

### 3. STEP 2C — Runtime capability

```
STORAGE_RUNTIME_WRITE_PROBE:
VERIFIED
```

Established runtime chain, proven via a controlled, fully-cleaned-up
probe:

```
Cloud Functions runtime
  → existing Admin SDK initializeApp() (zero-argument, shared by all functions)
  → default Storage bucket
  → write
  → metadata read
  → delete
```

- Bucket: `gs://auls-kitchen.firebasestorage.app`
- Location: `ASIA-SOUTHEAST2`
- Storage class / access frequency: Standard (Regional)

The Admin SDK write/read/delete path was exercised exactly once via a
temporary probe function, then the function, its source, and its test
object were fully removed. No probe object name is retained here as it
carries no ongoing audit value.

---

### 4. STEP 2D — Storage Security Contract

Locked paths:

- Manifest: `/catalog/manifest.json`
- Immutable snapshots: `/catalog/<sha256>.json`

Security contract (deployed, live):

```
/catalog/**
  anonymous READ = allowed
  client WRITE   = denied
  client DELETE  = denied

everything else
  client READ   = denied
  client WRITE  = denied
  client DELETE = denied
```

State:

- `storage.rules` is now repository-managed (new file, tracked in this
  checkpoint's commit).
- `firebase.json` points to it via `"storage": { "rules": "storage.rules" }`.
- Rules were deployed successfully (`firebase deploy --only storage`).
- Anonymous catalog READ was verified (HTTP 200).
- Non-catalog anonymous READ was denied (HTTP 403).
- Anonymous catalog WRITE was denied (HTTP 403).
- Anonymous catalog DELETE was denied (HTTP 403).
- The Admin SDK (server-side, via Cloud Functions) remains the only
  backend write path — it bypasses Storage Rules entirely by design, a
  fact independently confirmed during the Step 2C probe.

```
STORAGE_SECURITY_CONTRACT:
VERIFIED
```

---

### 5. STEP 2E — CORS Contract

Exact applied bucket CORS policy:

```json
[
  {
    "origin": ["https://kiosk.aulia.fun"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "ETag"],
    "maxAgeSeconds": 3600
  }
]
```

- Policy was applied to `gs://auls-kitchen.firebasestorage.app` via the
  Admin SDK (`bucket.setMetadata({ cors: [...] })`), the only mechanism
  this environment has authenticated access to (Firebase CLI has no
  Storage CORS command; `gcloud`/`gsutil` are not installed here).
- A second, independent authenticated metadata read (`bucket.
  getMetadata()`, not the setter's own return value) confirmed an exact
  match — no drift.
- No wildcard origin (`*`) is present.
- `aulia.fun` is **not** included.
- `auls-kitchen.web.app` is **not** included.
- `localhost` / `127.0.0.1` are **not** included.
- Write methods (`POST`/`PUT`/`PATCH`/`DELETE`) are **not** included —
  only `GET`/`HEAD`.

Final `storage.googleapis.com` response behavior (the actual redirect
target a browser's `fetch()` reads from) was verified directly:

- Approved Origin (`https://kiosk.aulia.fun`): `Access-Control-Allow-Origin`
  **present**, value `https://kiosk.aulia.fun`, with `Vary: Origin`.
- Unauthorized Origin (a test origin not on the allow-list): `Access-
  Control-Allow-Origin` **absent**.
- No Origin header sent: `Access-Control-Allow-Origin` **absent**.

In every case the underlying HTTP status remained 200 (Storage Rules
still grant public read regardless of CORS) — confirming **CORS does not
replace Storage Rules as the authorization boundary**; it only governs
which browser origins may read a response the server already decided
to send.

---

### 6. Production Kiosk origin status

- Intended production origin: `https://kiosk.aulia.fun`
- Current status at checkpoint: **NOT LIVE**
- DNS: **NXDOMAIN** (no A record, no CNAME — confirmed via independent
  DNS resolution, re-checked at this checkpoint's own time of writing)

```
PRODUCTION_BROWSER_E2E:
PENDING
```

No substitute origin was accepted as proof of this path. Specifically,
`https://aulia.fun` (live, but the customer-facing Menu site, not
confirmed as the Kiosk Experience origin), `https://auls-kitchen.web.app`
(a Firebase Hosting default domain, returns 404, not a real deployment),
and any `localhost`/`127.0.0.1` dev origin were each explicitly
considered and explicitly rejected as substitutes across Steps 2E/2E.1/
2E.2. **The full production browser delivery path is NOT marked
VERIFIED by this checkpoint.**

---

### 7. Verification matrix

| Item | Status |
|---|---|
| Storage provisioning | VERIFIED |
| Admin SDK runtime write | VERIFIED |
| Admin SDK metadata read | VERIFIED |
| Admin SDK delete | VERIFIED |
| `/catalog` anonymous read | VERIFIED |
| non-catalog anonymous read deny | VERIFIED |
| `/catalog` anonymous write deny | VERIFIED |
| `/catalog` anonymous delete deny | VERIFIED |
| bucket CORS metadata | VERIFIED |
| CORS approved-origin header | VERIFIED |
| CORS unauthorized-origin rejection | VERIFIED |
| production Kiosk browser fetch | PENDING — origin not live |

```
STORAGE_CORS_STATUS:
PARTIALLY_VERIFIED
```

This is not promoted to fully verified — the one test this contract
exists to satisfy (a genuine browser fetch from the real, live production
origin) has not occurred and cannot occur until `kiosk.aulia.fun` is live.

---

### 8. Cleanup proof

- All temporary Storage probe objects removed:
  - Step 2C's write probe object (deleted, confirmed absent).
  - Step 2D's `catalogSecurityProbeSetup` probe object (deleted, confirmed
    absent via anonymous GET → 404).
  - Step 2E.2's `storageCorsProbe` probe object (deleted, confirmed absent
    via anonymous GET → 404).
- All temporary probe/CORS functions removed:
  - `storageWriteProbe` — deployed, invoked, deleted (Step 2C).
  - `catalogSecurityProbeSetup` — deployed, invoked, deleted (Step 2D).
  - `storageCorsProbe` — deployed, invoked, deleted (Step 2E.2).
- Deployed Functions confirmed, at this checkpoint, to be exactly:
  ```
  healthCheck
  orderIntent
  posSale
  ```
  (re-verified read-only in Phase 2 of this checkpoint task, via
  `firebase functions:list --json`).
- No temporary source remains: a repository-wide search for
  `storageWriteProbe*`, `catalogSecurityProbeSetup*`, and
  `storageCorsProbe*` (excluding `node_modules`) returned zero matches at
  this checkpoint.
- `functions/index.js` is confirmed at its original, unmodified content
  (three exports only: `healthCheck`, `orderIntent`, `posSale`) — every
  temporary addition to it was reverted via `git checkout` immediately
  after each probe's use.

---

### 9. Frozen / untouched boundaries

The following were **NOT** modified by Steps 2C–2E:

- AWR
- Kiosk Domain
- Kiosk Experience
- Product Master
- OrderIntent behavior
- Firestore Rules
- Cloudinary preset
- DNS
- Cloudflare
- Firebase Hosting
- IAM

**Storage Rules and bucket CORS were intentionally changed** — these two
are the only infrastructure surfaces this body of work was authorized to
touch, and both changes are fully accounted for in Sections 4 and 5 above.

---

### 10. Deferred work

The following are explicitly **NOT IMPLEMENTED** as of this checkpoint:

- Catalog Projection
- canonical serialization
- SHA-256 revision generation
- Catalog Publisher
- manifest generation
- immutable snapshot generation
- Catalog Tablet Read Port
- dedicated IndexedDB Catalog Store
- stale/offline policy implementation
- Experience Discover integration
- production Kiosk hosting/DNS
- production browser E2E

This checkpoint records the **delivery foundation** (bucket, Security
Rules, CORS) only. It does not imply any of the above exists, and no code
for any of them has been written.

---

### 11. Next authorized scope

```
NEXT:
STEP 2F — Catalog Publish / Projection implementation planning
```

**NOT STARTED by this checkpoint task.** No Catalog Publish, Projection,
manifest, or snapshot code has been written or planned in detail beyond
the architecture already locked in the Step 2 Blueprint documents. Step
2F requires a separate Owner Gate before any implementation begins.
