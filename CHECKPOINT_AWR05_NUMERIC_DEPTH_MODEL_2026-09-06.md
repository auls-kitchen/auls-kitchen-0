# CHECKPOINT — AWR-05: EXPLICIT NUMERIC DEPTH MODEL (Z0–Z60)

## Scope: AUL World Runtime — Numeric Depth Model and Proof (AWR-05, addressing AWR-01 condition C4)

Date: 2026-09-06

## 1. Objective

Migrate the AUL World Runtime (`aul-world-runtime/`) depth/z-ordering
model from a categorical `DepthLayer` union
(`"background" | "midground" | "foreground"`) to an explicit numeric
depth scale, `DepthZ`, ranging Z0 (far background) to Z60 (ambient
foreground), and empirically prove that the renderer's draw order is
actually driven by that numeric value rather than by array/insertion
order. This addresses AWR-01 condition **C4** (explicit numeric depth
model) for the current PixiJS-based renderer.

## 2. Status

**PASS — C4 ADDRESSED FOR THE CURRENT (PIXIJS) RENDERER, DEVICE-SCOPED
PHYSICAL PROOF OBTAINED. C5 REMAINS OPEN (see Section 9).**

## 3. Architecture Summary

- **`state/depth.ts` (new):** domain-level numeric depth module.
  `DepthZ` is a branded `number` (`number & { readonly [depthZBrand]: true }`)
  — plain numbers cannot be assigned to it without going through the
  runtime validator `asDepthZ(value)`, which enforces `Number.isInteger`
  and the closed range `DEPTH_MIN=0`..`DEPTH_MAX=60`. Also defines
  `depthParallaxFactor(z: DepthZ): number`, a pure function mapping
  numeric depth to a parallax multiplier (`z < 20 → 0.25`,
  `z < 40 → 0.6`, else `1.0`).
- **`state/types.ts` / `state/initialState.ts`:** `WorldObject.layer:
  DepthLayer` replaced with `WorldObject.z: DepthZ`; all placeholder
  world objects now carry an explicit integer depth
  (bg-hill-1=0, bg-hill-2=10, mid-stall=30, menu_portal=35, cat-1=50,
  aul=60) instead of a category label.
- **`render/renderState.ts`:** `RenderObject.layer: DepthLayer` replaced
  with `RenderObject.z: DepthZ`; a pure pass-through of the domain value,
  no sorting performed at this layer.
- **`render/adapter/pixiRendererAdapter.ts`:** the previous three-Container
  architecture (`background`/`midground`/`foreground`, each with a fixed
  `PARALLAX_FACTOR`) was replaced with a single `world` Container
  (`sortableChildren = true`). Every sprite is added to `world`;
  `sprite.zIndex = obj.z` sets draw order; `world.sortChildren()` is
  called once per render pass. Camera/parallax transforms are now
  computed per object (not per container) using
  `depthParallaxFactor(obj.z)`, since parallax now varies continuously by
  numeric depth instead of being fixed per a small set of layers.
- **`render/depthProof.ts` (new) / `main.ts`:** an opt-in
  (`?depth-proof=1`) diagnostic scene — 7 overlapping objects at the same
  x/y, one per depth level (Z0, Z10, Z20, Z30, Z40, Z50, Z60), authored in
  **descending** array order (Z60 first) specifically so that a
  hypothetical regression to array-order-based rendering would collapse
  visibly into a single solid low-Z-colored disc instead of the correct
  7 concentric rings. This scene is never active in the normal AWR-04/05
  World scene; it exists purely as a targeted, falsifiable visual proof
  of the `zIndex`/`sortChildren()` draw-order mechanism.

## 4. C4 Sub-Condition Acceptance Status

| # | Sub-condition | Verified by | Status |
|---|----------------|-------------|--------|
| C4.1 | Explicit numeric depth type exists, branded and runtime-validated (not a bare `number`, not a category union) | `state/depth.ts` inspection (Gate 1) | PASS |
| C4.2 | Domain state (`WorldObject`) and derived render state (`RenderObject`) both carry the numeric `DepthZ`, with zero remaining references to the old `DepthLayer` union anywhere in the codebase | Gate 1–2 migration + repeated grep sweeps | PASS |
| C4.3 | Renderer draw order is driven by the numeric value (`zIndex` + `sortChildren()`), not by container membership or array/insertion order | `pixiRendererAdapter.ts` rewrite (Gate 3) | PASS |
| C4.4 | An independent, deliberately-discriminating visual proof exists that would visibly fail if the renderer reverted to array-order-based drawing | `render/depthProof.ts` bullseye scene, Z60→Z0 reversed authoring order (Gate 4) | PASS |
| C4.5 | Boundary integrity is preserved: the domain→Pixi boundary remains only through `RenderState → Adapter`; `World` does not import `Ordering` internals; the renderer does not import Firebase | Repository inspection / boundary audit (import graph of `render/adapter/pixiRendererAdapter.ts`, `state/`, `ordering/`) | PASS |
| C4.6 | The renderer migration introduces zero regression against every previously physically-proven AWR-04 behavior | Gate 6 — full R1–R7 regression suite (boot, Cat/Aul/Menu Portal touch, World↔Ordering boundary, reload recovery, touch after reload), all PASS, zero console errors | PASS |
| C4.7 | The numeric depth model is proven on a real physical Android device, not only in headless/desktop browser conditions | Gate 7 — physical device test reported by the user/architect (Section 6) | PASS (device-scoped; see Section 6 attribution note) |

**Supporting implementation verification (not part of the C4.5 contract, retained as separate evidence):** the numeric depth renderer and the proof scene were also confirmed to build cleanly and render correctly under empirical (headless) browser verification — Gate 5, Playwright verification of both the normal scene and `?depth-proof=1`, screenshots captured, zero console/page errors. This is build/render evidence, not a boundary-integrity check, and is not itself the basis for the C4.5 PASS above.

## 5. Implementation Commit and Deployment

- **Implementation commit:** `046194bc6911cbc3805ead42935c145ae4685023`
  — `feat(awr): implement numeric-z depth model and proof`
- Contains exactly 7 files: `main.ts`,
  `render/adapter/pixiRendererAdapter.ts`, `render/renderState.ts`,
  `state/initialState.ts`, `state/types.ts`, `render/depthProof.ts` (new),
  `state/depth.ts` (new). No other file is part of this commit.
- Pushed to `origin/main`; `HEAD == origin/main ==
  046194bc6911cbc3805ead42935c145ae4685023` (verified).
- **GitHub Pages deployment proof:** GitHub Pages deployment was manually
  triggered through the repository's GitHub Actions UI after
  implementation commit `046194b` was pushed to `main` — the user
  manually selected "Run workflow" with Branch: `main`. Workflow run #2
  (`34056543532`, `aul-world-pages-preview.yml`, event
  `workflow_dispatch`) used commit `046194bc6911...` on `main` (exact
  match to the implementation commit): Build = Success, Deploy =
  Success, started `2026-09-06T19:58:51Z`. This trigger was not
  performed by this session at any point.

## 6. Physical Gate 7 Device Proof

**Attribution note:** this sandbox environment has no physical Android
hardware access. The physical test below was performed by the architect
on their own device and reported back for recording in this checkpoint —
it is not something independently witnessed, executed, or verifiable
by this session. This distinction is stated explicitly, consistent with
this checkpoint series' standing rule to never represent headless or
simulated results as physical proof, and to never claim physical
verification that this session did not itself perform or directly
observe.

**Device configuration (same physical unit as AWR-04):**
- Advan Tab A10
- Android 14 / API 34
- Chrome
- 1280×800, landscape
- ARM64

**Reported physical test results:**

| # | Test | Result |
|---|------|--------|
| 1 | Normal World scene boot | PASS |
| 2 | AWR-05 Depth Proof scene (`?depth-proof=1`), 7 numeric depth levels Z0–Z60 visually verified | PASS |
| 3 | Cat touch | PASS |
| 4 | Aul touch | PASS |
| 5 | Menu Portal → Ordering | PASS |
| 6 | Ordering → World | PASS |
| 7 | Reload recovery | PASS |
| 8 | Touch after reload | PASS |

No visible crash, freeze, or render corruption was reported. No FPS,
CPU, GPU, RAM, thermal, or battery benchmark was performed or is claimed
by this checkpoint — consistent with the performance-measurement
discipline established in the AWR-04 checkpoint.

## 7. Explicit Limitations / Non-Claims

- NOT proof for any Android device other than the one tested.
- NOT proof for any Chrome version other than the one tested.
- NOT a performance/FPS/CPU/GPU/RAM/thermal/battery benchmark of any
  kind — none was measured or is claimed.
- NOT proof of final 2.5D asset performance (placeholder shapes only).
- NOT proof of final production Kiosk performance.
- NOT a claim that the numeric depth model has been validated with a
  second, independent rendering engine.
- NOT a claim that AWR-01 condition **C5** (renderer-replacement
  resilience) is addressed, tested, or closed by this checkpoint in any
  way — C5 is untouched by AWR-05 and remains exactly as open as it was
  after AWR-04.
- Does NOT infer, propose, or commit to any next scope beyond what is
  already reflected in the existing AWR-01 roadmap (C5).

## 8. Repository Safety

- No production frontend file (`aul-pos.html`, `aul-adm.html`,
  `index.html`, `customer-display.html`, `auls-kitchen-menu.html`,
  `functions/`, `.firebaserc`) was touched by AWR-05.
- No Firebase, Firestore, Cloud Functions, or Cloudflare configuration
  was modified.
- `firebase.json` and `firestore.rules` remain the pre-existing, EMU-4,
  local-emulator-only artifacts — unrelated to and unaffected by AWR-05
  or this checkpoint. They are not committed by this or any prior
  checkpoint in this series.
- No dependency was added or upgraded; no lockfile touched; no Vite or
  GitHub Actions workflow configuration was changed by AWR-05 (both
  remain exactly as set by the separately-authorized AWR-04P work).

## 9. AWR-01 Conditions Status (after AWR-05)

- **C1 — ADDRESSED** (AWR-02).
- **C2 — PROVEN** for the defined AWR-03 mock Ordering boundary (AWR-03).
- **C3 — PROVEN** for the tested device configuration (AWR-04).
- **C4 — ADDRESSED** for the current PixiJS renderer: explicit numeric
  `DepthZ` (Z0–Z60) domain model, numeric-driven draw order, empirical
  headless proof, zero regression, and device-scoped physical proof (this
  checkpoint).
- **C5 — OPEN.** Renderer-replacement resilience remains structurally
  argued only, not empirically tested with a second renderer. AWR-05 does
  not open, address, or make any claim about C5.

## 10. Next Authorized Direction

C5 (empirical renderer-replacement proof) remains open and requires
separate, explicit architect authorization before any further
implementation work begins. This checkpoint does not propose or infer
scope for that work.
