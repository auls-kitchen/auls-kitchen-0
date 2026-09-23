# CHECKPOINT — PRODUCTION ASSET BOUNDARY V1

Date: 2026-09-23

## 1. Checkpoint Identity

- Scope name: Production Asset Boundary V1
- Date: 2026-09-23
- Status: COMPLETE — DEPLOYED AND LIVE-VERIFIED
- PR: #7 `feat(cloudflare): establish production asset boundary`
- Feature commit: `327a4897a4277f34ce8f570c9c2ca95b8073bfa4`
- Merge commit on `main`: `6828f43f9761deec8173c225ebc509c13ef4b082`

## 2. Problem / Background

- Production `aulia.fun` is served by the Cloudflare Worker `auls-kitchen-0`, deployed by Workers Builds on every push to `main` (`npx wrangler deploy`, no build step, no approval gate, new version at 100% traffic).
- The repository had no committed Wrangler configuration.

## 3. Previous Implicit Asset Boundary (insecure)

- With no config present, Wrangler auto-detected the project on every build ("Framework: Static", "Output Directory: .") and accepted the defaults non-interactively.
- The static asset directory was therefore the repository root `.`.
- Build `95231406-79e0-4eb2-89c6-afbdd6af252a` (commit `0373880`, version #50) read 169 files from the repository root and uploaded, among others:
  - `/.git/HEAD`, `/.git/index`, `/.git/FETCH_HEAD`, `/.git/logs/HEAD`
  - `/.git/objects/pack/*.pack` / `.idx` / `.rev`
  - `/aul-world-runtime/CHECKPOINT_AWR_FINAL_FREEZE_HANDOFF_2026-09-07.md`
- Nobody chose this boundary; it was a Wrangler auto-configuration default.
- Whether these paths were reachable from `aulia.fun` before the fix was not verified. The Claude environment could not reach the site.

## 4. Discovery

A read-only source audit of the four production entry points found:

- `/` (`index.html`): no local file dependencies. All menu images and the QRIS image are inline `data:` URIs.
- `/aul-adm` (`aul-adm.html`): links to `aul-pos.html`.
- `/aul-pos.html`: uses `manifest-pos.json`, `icon-192.png`, registers `sw.js`, and links to `aul-adm.html`.
- `/customer-display.html`: uses `manifest-cd.json`, `icon-192.png`, registers `sw.js`.
- Both manifests reference `icon-192.png` and `icon-512.png`.
- `sw.js` is a minimal pass-through worker with no further references.
- No runtime dependency exists on `functions/`, `aul-world-runtime/`, `tools/`, `*.md`, `firebase.json`, `.firebaserc`, or `.git/`.
- All other dependencies are external (Firebase SDK via gstatic, Google Fonts, Cloudinary, `wa.me`).
- `/aul-adm` (without `.html`) relies on `html_handling: "auto-trailing-slash"`.

## 5. Locked Production Surface (exactly 9 files)

```
public/
├── index.html
├── aul-adm.html
├── aul-pos.html
├── customer-display.html
├── manifest-pos.json
├── manifest-cd.json
├── sw.js
├── icon-192.png
└── icon-512.png
```

These legacy files intentionally remain in the repository root, outside the served surface:

- `aul-migrate.html`
- `aul-pos-1.html`
- `auls-kitchen-menu.html`
- `category-diagnostic.html`
- `category-master-populate.html`
- `QR_Menu_AULsKitchen.png`

## 6. Implementation

- The 9 files were moved into `public/` with `git mv`. Every file is a 100% rename, and blob hashes are identical to `main`.
- Added `wrangler.jsonc`:
  - `name`: `auls-kitchen-0` (unchanged)
  - `compatibility_date`: `2026-09-03` (unchanged)
  - `observability.enabled`: `true`
  - `assets.directory`: `./public`
  - `assets.html_handling`: `auto-trailing-slash` (preserved)
  - `assets.not_found_handling`: `none` (preserved)
- No Worker script and no bindings were added, the same as before.
- No application code, Firebase, Functions, Catalog, AWR, or Kiosk Domain changes.

## 7. Validation (pre-merge)

- All 9 files present under `public/`, with no root duplicates and no unrelated files moved.
- Both manifests are valid JSON, and their icon references resolve inside `public/`.
- All local page references (manifests, icon, `sw.js`, cross-page links) resolve inside `public/`.
- `node --check public/sw.js`: OK.
- `wrangler.jsonc` parses.
- `npx wrangler@4.129.0 deploy --dry-run`: "Read 9 files from the assets directory …/public", "No bindings found", exit 0.
- `git diff --check`: clean.

## 8. Cloudflare Deployment Evidence

Sources: read-only Cloudflare API calls (Workers Builds builds and logs, Worker deployments and versions).

- Workers Build `6dd89948-577a-45f2-913a-d563296caa03`
  - Trigger: `push_event` on `main`, commit `6828f43f9761deec8173c225ebc509c13ef4b082`
  - Created 05:33:28, running 05:33:33, stopped 05:33:58 UTC. Outcome: **success**.
  - Log: Wrangler used the committed config (no auto-detection prompts).
  - Log: "Read 9 files from the assets directory /opt/buildhome/repo/public".
  - Log: "No updated asset files to upload". The file contents are the same as before.
  - Log: "Current Version ID: 3b1f51df-8de5-4db3-a9d7-fc6f947bb408".
- Production deployment `7d6f994d-19aa-4c3e-84f8-f9585302718c`, created 05:33:55 UTC.
- Production version #51 `3b1f51df-8de5-4db3-a9d7-fc6f947bb408` at **100% traffic**.
- Correlation chain:
  - merge commit → build: exact SHA in the build record
  - build → version: version ID printed in the build log
  - version → traffic: deployment routes 100% to that version

## 9. Live Browser Verification (aulia.fun)

PUBLIC — all verified OK:

- `/`
- `/aul-adm`
- `/aul-pos.html`
- `/customer-display.html`
- `/manifest-pos.json`
- `/manifest-cd.json`
- `/sw.js`
- `/icon-192.png`
- `/icon-512.png`

NON-PUBLIC — all verified 404:

- `/.git/HEAD`
- `/functions/index.js`
- `/firebase.json`
- `/storage.rules`
- `/CHECKPOINT_AWR04_REAL_ANDROID_TOUCH_PERFORMANCE_2026-09-06.md`
- `/aul-world-runtime/`
- `/tools/`

## 10. Final Status

- The production static surface is explicit, committed, and limited to the 9 locked files in `public/`.
- The production URL contract is unchanged.
- Internal repository content (`.git`, `functions/`, `tools/`, `aul-world-runtime/`, docs, config) is no longer served.
- Production Asset Boundary V1: **CLOSED**.

## 11. Open Items (outside this scope)

- Pre-fix exposure window: earlier deployments uploaded `.git` as a static asset, and live reachability before the fix was never verified. A review of git history for any committed credentials remains advisable.
- `main` has no branch protection, no required reviews and no required checks, while every merge deploys to 100% production automatically.

## 12. PR #6 — Catalog Publish

- PR #6 `feat(catalog): publish Catalog Snapshot infrastructure` is **separate from this checkpoint and remains UNMERGED**.
- Nothing in this scope modified, merged, or deployed PR #6.
- Its Firebase live-state verification (`catalogPublish` callable, Storage rules for `/catalog/**`, anonymous read/write behavior) remains open.
- PR #6 must be re-reviewed against the new `public/` layout before any merge. It modifies `aul-adm.html` at the old root path.
