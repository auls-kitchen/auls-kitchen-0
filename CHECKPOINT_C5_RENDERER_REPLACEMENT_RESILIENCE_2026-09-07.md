# CHECKPOINT — C5: RENDERER REPLACEMENT RESILIENCE

## A. Checkpoint Identity

- Project: AUL's Kitchen / AUL World Runtime
- Condition: C5
- Status: **CLOSED**
- Date: 2026-09-07
- Previous architectural checkpoint: AWR-05 numeric depth model
  (CHECKPOINT_AWR05_NUMERIC_DEPTH_MODEL_2026-09-06.md)

## B. Authoritative C5 Definition

Authoritative wording (CHECKPOINT_AWR01_RUNTIME_FOUNDATION_2026-09-06.md,
Section 17):

"C5. Renderer replacement resilience is structurally designed but not
empirically tested with a second renderer."

**This condition is now CLOSED.** The second-renderer empirical proof
required by this wording has been completed, verified, committed,
pushed, and deployed.

## C. Architectural Claim

Proven boundary:

```
Domain State -> RenderState -> Renderer Adapter -> Renderer Technology
```

The proof demonstrated that PixiJS can be replaced by native Canvas 2D
without changing:

- domain state
- state types
- reducers
- event bus
- World/Ordering boundary
- RenderState
- existing domain-visible event behavior

Only a new renderer adapter module and a single opt-in selection branch
in `main.ts` were required.

## D. Discovery

C5 Discovery was completed before implementation (read-only inspection)
and identified:

- an existing `RendererAdapter` contract already defined in
  `pixiRendererAdapter.ts` (`init`/`render`/`onObjectPointerDown`/
  `destroy`) — no new abstraction needed to be invented.
- `RenderState` (`render/renderState.ts`) as plain data, with zero
  PixiJS types.
- PixiJS import isolated to exactly one file
  (`render/adapter/pixiRendererAdapter.ts`) across the entire
  `aul-world-runtime/src/` tree.
- `main.ts`'s renderer-construction call site as the only place needing
  a selection branch to swap adapters.
- native Canvas 2D as the minimal, materially different rendering
  technology suitable for a falsifiable proof (starkest contrast to a
  WebGL-backed library, zero new dependency).

## E. Implementation

**Created:**
- `aul-world-runtime/src/render/adapter/canvas2dTestAdapter.ts`

**Modified:**
- `aul-world-runtime/src/main.ts`

Details:
- Canvas 2D is opt-in only, via `?renderer=canvas2d` in the URL query
  string — mirrors the existing `?depth-proof=1` idiom.
- Normal boot (no query parameter) remains PixiJS, unchanged.
- No domain/state/RenderState file was changed.
- No new dependency was added (`package.json`/lockfile diff empty).
- `canvas2dTestAdapter.ts` is a temporary, disposable proof adapter —
  not production renderer code. It imports nothing from `state/*`,
  `ordering/*`, `behavior/*`, `world/*`, `pixi.js`, or
  `pixiRendererAdapter.ts`; its only cross-module import is the
  plain-data `RenderState` type. Canvas dimensions and the
  parallax-factor formula are intentionally duplicated as local
  constants (matching `state/worldConstants.ts` / `state/depth.ts`
  values) rather than imported, specifically to keep this file at zero
  `state/*` imports — a disclosed, proof-scoped choice, not a proposal
  to remove those modules' role as the single source of truth for
  normal (PixiJS) operation.

## F. Verification

| Gate | Result |
|------|--------|
| C5.1 Adapter contract | PASS |
| C5.2 Boundary isolation | PASS |
| C5.3 Build integrity | PASS |
| C5.4 Empirical Canvas 2D runtime | PASS |
| C5.5 R1–R7 regression parity | PASS |
| C5.6 Falsification audit | PASS |

Evidence:
- `tsc -p tsconfig.json --noEmit` — PASS, zero errors.
- `vite build` — PASS ("742 modules transformed", built in 5.77s).
- Canvas2D rendered actual pixels — direct pixel inspection of the
  canvas returned 30,802 non-background pixels, confirming objects were
  actually drawn, not just a blank fill.
- Depth ordering worked from `RenderState.z` — the adapter locally
  sorts a copy of `state.objects` by `.z` ascending before drawing,
  independent of PixiJS's `zIndex`/`sortChildren()` mechanism.
- Camera behavior worked — clicking Aul produced `mode=AUL_FOCUS`,
  `aul=happy`, `interactions=1`, with a before/after screenshot
  confirming an observable position/zoom change under Canvas 2D.
- Cat/Aul/Portal pointer paths worked — native pointer hit-testing
  correctly resolved each object's id and reached the existing
  `handleObjectHit(...)` → event bus path unchanged.
- Reload recovery worked — after `page.reload()`, HUD returned cleanly
  to `mode=WORLD_VIEW`, `interactions=0`.
- Zero `pageerror` (uncaught exception) events at any point.
- The existing favicon 404 (`Failed to load resource: 404
  (Not Found)` for `/favicon.ico`) remained the same known benign
  artifact documented since AWR-01 Section 9 and observed on every
  prior gate in this series — not a Canvas2D-specific or application
  defect.

## G. R1–R7 Regression

The existing AWR-04/05 Gate 6 regression assertions remained
**unchanged**. Only the navigation URLs were changed (goto and the
query-string-preserving reload) to activate `?renderer=canvas2d`;
every `results.r*_*` assertion is byte-for-byte identical to the
original script.

All R1–R7 PASSED under Canvas 2D, identically to the PixiJS run:
R1 boot, R2 Cat touch, R3 Aul touch, R4 Menu Portal → Ordering, R5
Ordering → World, R6 reload recovery, R7 touch after reload.

**The regression assertions were NOT modified** to achieve this result.

## H. Falsification Result

| Condition | Triggered? |
|-----------|------------|
| RenderState change required | FALSE |
| domain/state change required | FALSE |
| reducer/event bus change required | FALSE |
| World/Ordering change required | FALSE |
| event wiring change beyond renderer selection | FALSE |
| undeclared source file changed | FALSE |
| regression assertion modification required | FALSE |
| Canvas2D unable to consume existing RenderState | FALSE |

**No C5 falsification condition was triggered.**

## I. Commit

Commit: `ccd3bc395b6ffc59e5dcc07323a80dd0f2181260`
Subject: `feat(awr): prove renderer replacement resilience`

Contains exactly:
- `aul-world-runtime/src/main.ts`
- `aul-world-runtime/src/render/adapter/canvas2dTestAdapter.ts`

No other file is part of this commit.

## J. Push

- Branch: `main`
- Remote: `origin`
- Fast-forward push (`c329848..ccd3bc3 main -> main`), no force push.
- `HEAD == origin/main`
- Exact SHA: `ccd3bc395b6ffc59e5dcc07323a80dd0f2181260`

## K. Deployment

- Workflow: AUL World Runtime — Pages Preview (Manual, AWR-04P)
- Run: `34063278919`
- Run number: 3
- Event: `workflow_dispatch`
- Branch: `main`
- `head_sha`: `ccd3bc395b6ffc59e5dcc07323a80dd0f2181260`
- Conclusion: `success`

Deployment identity matches the C5 commit exactly.

URL smoke check: **not performed** — this sandbox's network egress
proxy blocked `auls-kitchen.github.io`. This is a sandbox environment
limitation, not a deployment failure; deployment identity was
independently confirmed via the GitHub Actions run record above.

## L. Physical Device

No physical-device C5 test was performed. Physical proof was not an
authoritative requirement of the C5 wording (Section B) — headless
browser empirical verification (Section F) is the required and
sufficient empirical evidence for this condition. No physical-device
result is claimed.

## M. Repository Safety

Final repository state:

```
 M firebase.json
?? firestore.rules
```

These are standing, pre-existing EMU-4 artifacts:
- NOT modified by C5.
- NOT committed by C5.
- NOT pushed by C5.

## N. Scope Boundary

C5 did NOT include:

- production Canvas renderer
- visual redesign
- performance benchmarking
- Kiosk
- POS
- Firebase
- payment
- production asset migration
- unrelated refactoring

## O. Architectural Conclusion

C5 is CLOSED because renderer replacement resilience has now been
empirically demonstrated through a second rendering technology using
the existing RenderState and renderer boundary, with domain/runtime
behavior preserved. This checkpoint does not claim universal renderer
compatibility or production readiness — the Canvas 2D adapter is a
temporary, disposable proof artifact, not a production rendering path.

## P. Next Condition

- C5: **CLOSED**
- C6: **OPEN / NOT STARTED**

This checkpoint does not define C6 scope and does not infer the next
implementation scope.
