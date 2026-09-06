# CHECKPOINT — AWR-04: REAL ANDROID / TOUCH / DEVICE PERFORMANCE PROOF

## Scope: AUL World Runtime — Real Android/Touch/Device Performance Proof (AWR-04, closing AWR-01 condition C3)

Date: 2026-09-06

## 1. Objective

Prove the current AUL World Runtime (`aul-world-runtime/`) on one real
Android device/browser configuration, physically exercising boot,
Canvas rendering, physical touch interaction, camera behavior, the
World ↔ Ordering boundary, sustained runtime stability, and reload
recovery. This closes AWR-01 condition C3 for the tested configuration
only — it is explicitly **not** a universal Android compatibility claim,
not a minimum-hardware specification, and not final production/Kiosk
performance certification.

## 2. Status

**PASS — DEVICE-SCOPED PHYSICAL PROOF**

## 3. Device Configuration (Test Device #1)

- Advan Tab A10
- Allwinner A523, 8× ARM Cortex-A55 up to 1.80 GHz
- Mali-G57 MC1
- RAM 4 GB
- Android 14 / API 34
- Chrome
- 1280×800, landscape
- ARM64/aarch64

This is a qualification/test device only — not the minimum specification
for AUL World Runtime, and not a stand-in for any other Android device,
Chrome version, or hardware tier.

## 4. Delivery Method

GitHub Pages project site, built via the manual-only
`.github/workflows/aul-world-pages-preview.yml` workflow (AWR-04P), base
path `/auls-kitchen-0/` (`aul-world-runtime/vite.config.ts`). No Android
packaging, no WebView wrapper — a plain browser runtime test, as intended.

## 5. Physical Test Matrix and Observed Results

| # | Test | Observed | Result |
|---|------|----------|--------|
| 1 | Fresh boot / initial load | Canvas rendered normally; DOM Test Panel rendered; frame counter advanced; initial state normal | PASS |
| 2 | Physical Canvas touch — Cat | `mode=CAT_FOCUS` | PASS |
| 3 | Physical Canvas touch — Aul | `mode=AUL_FOCUS`, `aul=happy`, `interactions` incremented to 1 on a fresh post-reload run; an earlier run in the same session reached `interactions=6` | PASS |
| 4 | Physical Canvas touch — Menu Portal | `mode=MENU_FOCUS`, `presentation=ORDERING`, `ordering=ready` | PASS |
| 5 | Ordering → World (DOM "Return to World") | `mode=WORLD_VIEW`, `presentation=WORLD`, `ordering=idle`; event log recorded `RETURN_TO_WORLD via dom` | PASS |
| 6 | Sustained runtime (~20 minutes observed, exceeding the original 5-minute target) | Runtime remained visible; canvas kept rendering; frame counter kept increasing (e.g. `frame=22596` → `frame=28804` across the observation window); state remained stable; no crash, freeze, unexpected reload, or visible state corruption | PASS WITH OBSERVATION (see Section 7 — no FPS derived from these counts) |
| 7 | Reload / recovery | Immediately after a manual page refresh: `mode=WORLD_VIEW`, `aul=idle`, `interactions=0`, `greeting=idle`, `presentation=WORLD`, `ordering=idle`; canvas rendered normally; frame counter advanced | PASS |
| 8 | Touch after reload | A single physical tap on Aul post-reload produced `mode=AUL_FOCUS`, `aul=happy`, `interactions=1`, with `greeting=idle`/`presentation=WORLD`/`ordering=idle` otherwise unchanged | PASS |

## 6. Correction / Supersession of the Earlier Touch Diagnostic

An earlier read-only diagnostic (AWR-04 Touch Diagnostic Report, this same
date) reported that physical canvas taps were not observed to increase
`interactions` and classified that specific touch path as an open,
unresolved question (primary classification G — no source-level defect
found; device/browser behavior remained the leading unverified
possibility). That diagnostic explicitly flagged its own central
uncertainty as requiring live, on-device evidence it could not itself
collect.

**This checkpoint's physical test matrix (Section 5, tests 2–4 and 8)
directly supersedes that earlier inconclusive result.** Canvas-driven
touch interaction is now physically confirmed working end-to-end for
Cat, Aul, and Menu Portal objects, including a full
`interactions: 0 → 1` transition observed on a fresh reload specifically
to remove any ambiguity from the earlier test session. The earlier
diagnostic's source-level findings (no CSS/DOM-overlay defect, no
double-transform defect, no base-path involvement, identical generic
code path for Aul/Cat) remain valid and are now corroborated rather than
contradicted by this physical evidence — the prior inconclusive result is
understood to have been a one-off targeting/session artifact during that
earlier physical run, not a reproducible defect.

## 7. Performance Measurement Discipline

- **FPS = NOT MEASURED.**
- Frame time, GPU utilization, CPU utilization, memory usage, thermal
  throttling, and battery performance = **NOT MEASURED**.
- The `frame` counter observed increasing from `22596` to `28804` over
  the sustained-runtime observation window proves only that the
  `requestAnimationFrame` loop kept progressing continuously for the
  duration of that window — it is explicitly **not** converted into or
  represented as an FPS figure, frame-time average, or any other derived
  performance metric anywhere in this checkpoint.

## 8. Scope of the C3 Conclusion

**C3 is PROVEN for the tested configuration only:**
Advan Tab A10 / Android 14 / Chrome / 1280×800 landscape.

This physical test proves, for that configuration:
- real Android runtime boot
- Canvas rendering
- physical Canvas touch (Cat, Aul, Menu Portal)
- Aul interaction (mood, interaction count, camera focus)
- Cat interaction (camera focus)
- Menu Portal interaction (World → Ordering boundary entry)
- World ↔ Ordering boundary behavior (enter and return)
- sustained runtime observation (~20 minutes, no crash/freeze/corruption)
- reload recovery (state resets cleanly to initial values)
- touch after reload (interaction remains functional post-reload)

## 9. Limitations (explicitly NOT proven by this checkpoint)

- NOT proof for all Android devices.
- NOT proof for all Chrome versions.
- NOT proof for lower-end hardware than the tested device.
- NOT proof of final 2.5D asset performance (placeholder shapes only were
  tested — no production Aul/cat/menu artwork).
- NOT proof of final production Kiosk performance.
- NOT proof of long-duration thermal stability beyond the ~20-minute
  observed session.
- NOT a final FPS target (none was measured or set).
- NOT a final memory budget (not measured).
- NOT proof of final UX with production assets.

## 10. Repository Safety

- No application source file was changed by this closure task — VERIFIED
  via `git diff --stat -- aul-world-runtime/ .github/` returning empty
  immediately before this checkpoint was written.
- No production frontend file (`aul-pos.html`, `aul-adm.html`,
  `index.html`, `customer-display.html`, `auls-kitchen-menu.html`,
  `functions/`, `.firebaserc`) was touched.
- No Firebase, Firestore, Cloud Functions, or Cloudflare configuration
  was modified.
- No deployment, publish, or production-hosting action was performed.
- No dependency was added or upgraded; no `package.json`/lockfile was
  touched; no Vite configuration was changed by this task (the base-path
  value remains exactly as set by the prior, separately-authorized
  AWR-04P fix).

## 11. Standing Local Files

```
 M firebase.json
?? firestore.rules
```
These remain the pre-existing, EMU-4, local-emulator-only artifacts —
unrelated to and unaffected by this checkpoint. They are not committed by
this or any prior checkpoint in this series.

## 12. AWR-01 Conditions Status (after AWR-04)

- **C1 — ADDRESSED** (AWR-02).
- **C2 — PROVEN** for the defined AWR-03 mock Ordering boundary (AWR-03).
- **C3 — PROVEN** for the tested device configuration (this checkpoint).
  RT-11 from AWR-03 (independent evolvability of World from a real
  Cart/Product/Payment implementation) remains INFERRED, unaffected by
  this checkpoint.
- **C4 — OPEN.** The prototype still uses three visual depth groups
  rather than the full Z0–Z60 rendering model.
- **C5 — OPEN.** Renderer replacement resilience remains structurally
  argued, not empirically tested with a second renderer.

## 13. Explicit Scope Boundary Statement

This checkpoint does not claim universal Android compatibility, final
production readiness, final performance/FPS targets, or that the real
AUL World or a real Kiosk ordering system has been built. AWR-04 remains
scoped to the one physical device tested, confined to
`aul-world-runtime/`, with zero connection to Firebase, Firestore, Auth,
Cloud Functions, `posSale`, `orderIntent`, payment, the production
catalog, or any production asset.

## 14. Next Authorized Direction

C4 (full Z0–Z60 depth model) and C5 (empirical renderer-replacement
proof) remain open and require separate, explicit architect
authorization before any further implementation work begins.
