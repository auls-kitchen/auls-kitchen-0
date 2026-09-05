# CHECKPOINT — AWR-01: AUL WORLD RUNTIME FOUNDATION

## Scope: AUL World Runtime — Architecture & Engine Selection Gate (AWR-01)

Date: 2026-09-06

## 1. Checkpoint Identity

- Scope name: AWR-01 (AUL World Runtime — Architecture & Engine Selection Gate)
- Date: 2026-09-06
- Status: **PASS WITH CONDITIONS** (architect-reviewed and approved for closure)
- Branch: main
- HEAD at closure commit's parent: `877460f7b947686e173c42da7d1d40f5b022a4f2`
- This checkpoint's own commit becomes the new HEAD once pushed.

## 2. AWR-01 Purpose

AWR-01 was an investigation/prototype gate only — it evaluated the safest
foundation for a future AUL World Runtime and built the smallest isolated
technical proof necessary to validate the architecture. **AWR-01 did NOT
build the real AUL World.** No production behavior, production file, or
production deployment was authorized or touched by this scope.

## 3. Actual Repository Findings (at AWR-01 start)

Verified by direct inspection, not assumed from memory:
- No root-level `package.json` existed; the only prior `package.json` was
  `functions/package.json` (Cloud Functions, Node 20).
- No Vite config, no TypeScript config, no bundler anywhere in the repository.
- Every frontend file (`aul-pos.html`, `aul-adm.html`, `index.html`,
  `customer-display.html`, etc.) is plain static HTML loading Firebase
  directly via `<script type="module">` from the gstatic CDN — no frontend
  build step exists.
- No Construct 3, PixiJS, Phaser, or Three.js references existed anywhere.
- No Cloudflare/wrangler configuration file exists in the repository.
- Node v22.22.2 / npm 10.9.7 available; npm registry reachable; unpkg.com
  blocked by sandbox egress policy (irrelevant — not needed for npm install).

## 4. Selected Isolated Runtime Location

New, fully separate top-level directory: **`aul-world-runtime/`**

- Own `package.json`, `node_modules/`, `dist/` (both gitignored via a nested
  `.gitignore` added inside this directory).
- Zero references to or from any production file. Not wired into Cloudflare's
  existing static-file serving in any way.
- Selected because the repository's production frontend has no build/module
  boundary of its own to safely extend, and a fully separate package was the
  only option guaranteeing zero coupling to production files, Firestore
  Rules, or `firebase.json`.

## 5. Engine Comparison Conclusion

PixiJS, Phaser, Three.js, and a minimal custom Canvas/WebGL approach were
compared against 17 AUL-specific criteria (hybrid DOM+Canvas compatibility,
2.5D layering, parallax, camera control, touch interaction, asset
loading/caching, Android Chrome/low-mid-range suitability, TypeScript
integration, bundle control, renderer/domain isolation, maintainability,
debugging, performance control, and the ability to implement the locked AUL
architecture without fighting the foundation).

**Conclusion:** PixiJS is the strongest fit. Phaser's opinionated
scene/game-loop ownership actively conflicts with the locked "renderer is
infrastructure, not authority" principle. Three.js solves a 3D problem AUL
World does not have. A custom Canvas/WebGL implementation would re-solve
problems (batching, texture caching, unified pointer events) PixiJS has
already solved, without architectural benefit.

## 6. Approved Rendering Foundation

**PixiJS (v8.6.6)** — APPROVED AS THE RECOMMENDED RENDERING FOUNDATION,
per architect decision following AWR-01's proof. PixiJS is infrastructure,
not domain authority. The enforced boundary is:

```
AUL Architecture -> Renderer Adapter -> PixiJS
```

Exactly one file in the prototype (`src/render/adapter/pixiRendererAdapter.ts`)
imports `pixi.js` — verified by direct grep across the entire prototype
source tree, not asserted.

## 7. Approved Build Foundation

**Vite + TypeScript** — APPROVED. No existing tooling could be reused (none
existed for the frontend). Confirmed to build cleanly in this repository's
environment with zero impact on the `functions/` Node toolchain or any
frontend HTML file.

## 8. Implemented Prototype Architecture

```
aul-world-runtime/src/
  state/        WorldState, CameraState, AulState, CatState, CustomerState,
                OrderingState (stub), SystemState — plain data only.
  events/       Semantic AppEvent union (OBJECT_INTERACTED,
                CAMERA_FOCUS_REQUESTED, DOM_PANEL_ACTION, TICK) + a minimal
                event bus (subscribe/emit only).
  behavior/     reducer.ts — the ONLY place domain state changes. A single
                canonical focusTargetForMode() function is shared by both
                the canvas object-interaction path and the DOM camera-button
                path (see Section 10, bug #2).
  world/        interactionContract.ts (object CLASS -> Intent) and
                hitTestPipeline.ts (object id -> intent -> semantic event).
  render/
    renderState.ts                  pure projection: WorldState -> plain
                                     RenderObject[]/RenderCamera/hudText.
    adapter/pixiRendererAdapter.ts  the ONLY file importing "pixi.js".
  dom/          domPanel.ts — plain DOM test panel, talks only to the event
                bus, never touches the renderer or raw domain state.
  assets/       assetBoundary.ts — domain-safe placeholder-asset descriptor;
                the actual loaded-resource cache lives inside the adapter.
  platform/     resize.ts — CSS-scale-to-fit on window resize.
  main.ts       Bootstraps store + adapter + DOM panel; wires
                EVENT -> DISPATCH -> REDUCER -> RENDER STATE -> CANVAS/DOM.
```

Six placeholder world objects (plain colored circles, no production
artwork) across the required object classes (Decorative, Reactive, Portal,
Character). Three depth-layer Containers (background/midground/foreground)
with distinct parallax factors. Camera modes WORLD_VIEW, AUL_FOCUS, and
CAT_FOCUS are implemented and trigger-able from both canvas interaction and
DOM controls; OBJECT_FOCUS/EVENT_FOCUS/MENU_FOCUS are typed but MENU_FOCUS is
the only one of those three with a real trigger (via the portal object).

## 9. Verification Performed

Static:
- `tsc --noEmit` (strict mode) — PASS.
- `vite build` — PASS. Output ~76.5 kB gzip application+PixiJS-core chunk
  plus separately lazy-loaded per-backend renderer chunks (WebGL/WebGPU/
  Canvas2D fallback).
- Grep-verified architectural boundary claims: exactly one file imports
  `pixi.js`; zero real Firebase/Firestore references (two incidental comment
  matches inspected and excluded); no direct DOM-to-domain-state access; no
  `Graphics`/`Texture` creation outside the adapter; largest source file is
  134 lines, 652 lines total across 14 files.

Runtime (headless Chromium via Playwright against a local Vite preview
server on 127.0.0.1 — reachable in this sandbox, unlike the blocked gstatic
CDN case from earlier scopes):
- Canvas and DOM panel both render.
- Canvas click on the Aul placeholder -> real hit test -> `OBJECT_INTERACTED`
  event -> state change (mood, camera mode) -> DOM panel status text updates
  (Canvas -> state -> DOM proof, PASS).
- DOM "Camera: World View" / "Camera: Aul Focus" buttons -> camera genuinely
  moves/zooms, screenshot-confirmed visual difference between the two modes,
  including a visible parallax difference between foreground and background
  layers (DOM -> state -> Canvas proof, PASS).
- DOM "Greet Aul" button -> Aul's canvas circle recolors and gains a
  highlight ring (PASS).
- Canvas click on the cat placeholder -> `CAT_FOCUS` mode engages, asleep
  state toggles (PASS).
- Event log panel accurately lists every semantic event from both sources in
  order (PASS).
- One benign console 404 observed on every load (`/favicon.ico`), confirmed
  via direct request to be the browser's automatic favicon request against a
  page defining none — not an application defect.

## 10. Bugs Discovered and Fixed During Verification

Verification was adversarial, not a rubber stamp — two real defects were
found and fixed before this checkpoint:

1. **Camera double-offset bug.** The initial camera-transform math offset
   every world object by the canvas center a second time, so at rest the Aul
   placeholder rendered off the visible canvas entirely and clicking its
   authored coordinates hit nothing. Confirmed via a failing Playwright
   assertion (empty interaction log) before the fix, passing after. Fixed by
   defining WORLD_VIEW's "at rest" camera target as the canvas center
   (`state/worldConstants.ts`) instead of `(0,0)`.
2. **DOM camera-button no-op bug.** The DOM "Camera: Aul Focus" button
   changed the HUD's mode label but never actually computed a real camera
   target — only the canvas-click-on-Aul path did. Fixed by extracting a
   single `focusTargetForMode()` function in the reducer, now used by both
   the canvas object-interaction path and the DOM camera-button path, so the
   two entry points cannot drift apart again.

Both fixes are contained entirely within `aul-world-runtime/`; no production
file or unrelated code was touched to make these fixes.

## 11. Performance Observations

- Build time ~3.5–3.7s (this environment only).
- Bundle: 76.52 kB gzip application+PixiJS-core chunk, plus lazily-split
  per-backend renderer chunks (WebGL 19.71 kB gzip, WebGPU 13.34 kB gzip,
  Canvas fallback 6.18 kB gzip).
- npm install ~11s, 24 packages.
- No obvious memory-leak pattern observed in the render loop (bounded shape
  cache, six placeholder objects) — a code-level observation, not a
  measured profile.
- **NOT MEASURED — ENVIRONMENT LIMITATION:** real mobile-device, Android
  Chrome, Android kiosk, or real touch-input performance/behavior. No such
  device was reachable from this sandbox. Headless-desktop-Chromium
  responsiveness is not a substitute and is not claimed as such.

## 12. Unverified Items (explicit, not glossed over)

- Real mobile/Android/touch-device behavior — NOT VERIFIED.
- Renderer-swap resilience — INFERRED from the adapter boundary's structure,
  not empirically proven (no second renderer was implemented).
- The "External Effects" half of the locked architecture (Section 2 of the
  AWR-01 scope) was never exercised — this prototype only demonstrates the
  synchronous EVENT -> DISPATCH -> REDUCER -> RENDER path.
- World -> Ordering functional hand-off is only demonstrated as a camera
  focus change (MENU_FOCUS); no actual cross-domain hand-off exists.

## 13. Dependency Audit

| Package    | Type | Purpose                                    |
|------------|------|---------------------------------------------|
| pixi.js    | runtime | Approved rendering foundation (Section 6) |
| typescript | dev  | Compile-time enforcement of the domain/renderer import boundary |
| vite       | dev  | Dev server + production bundler; no existing tooling to reuse |

No physics engine, ECS, audio engine, analytics, notification SDK, Firebase
SDK, payment SDK, networking/multiplayer framework, generic plugin
framework, AI/LLM runtime, or additional UI framework was added — confirmed,
`package.json` lists exactly the three packages above.

Two known dev-only vulnerabilities were disclosed and left unresolved
(esbuild, bundled transitively by Vite's dev server, GHSA-67mh-4wv8-2f99 —
affects only a running `vite dev` server, not the production build output or
this never-deployed prototype; fixing requires a breaking Vite major-version
bump not justified for this scope).

## 14. Red-Team Summary

Checked against actual code (grep evidence), not asserted:
- Renderer cannot become domain authority (adapter never references domain
  state, only plain RenderState + emitted object-id callbacks).
- No PixiJS types leak into domain state (single import site, verified).
- DOM cannot directly mutate domain state (`domPanel.ts` only calls
  `bus.emit`).
- World has zero real Firebase/Firestore coupling (verified; two comment
  hits were the only false positives, inspected and excluded).
- Event bus is not a singleton/global (one instance, owned by `main.ts`).
- No "giant file" risk (largest file 134 lines; 652 lines total).
- Asset loading is not scattered (single creation site inside the adapter).
- Camera-logic/renderer coupling was a REAL finding (Section 10, bug #2) —
  found and fixed by centralizing focus-target logic in the reducer.
- Behavior/rendering coupling: none found (reducer has zero
  PixiJS/DOM imports).
- Dependency growth: none found (3 total dependencies, all justified).
- World/Ordering dependency cycle: not yet applicable — OrderingState is a
  one-field stub with no separate module to cycle with.
- Does not accidentally become a generic game engine: no physics, ECS, or
  plugin system; stays a thin domain-plus-adapter.

## 15. Production Safety Result

**NONE.** Verified directly:
- `git diff --stat` against every production file (`aul-pos.html`,
  `aul-adm.html`, `index.html`, `customer-display.html`,
  `auls-kitchen-menu.html`, `functions/`, `.firebaserc`, and other legacy
  HTML files) is empty, both before and after this closure scope.
- No Firebase project, Firestore data, Firestore Security Rules, Cloud
  Function, or Cloudflare configuration was touched.
- The prototype has no import, reference, or build-time dependency to or
  from any production file, and is NOT connected to Firebase, Firestore,
  Auth, Cloud Functions, `posSale`, `orderIntent`, payment, the production
  catalog, or any production asset.

## 16. Deployment Result

**NONE.** Not deployed, not published. Only ever run locally in this sandbox
via `npm run dev` / `npm run preview`; the local preview server was stopped
before this checkpoint. No `firebase deploy`, Cloudflare deploy, or wrangler
command was run at any point in this scope.

## 17. Open Conditions Carried Forward (NOT fixed in this closure — future scope items)

- **C1.** External Effects pattern has not yet been exercised with a
  representative mock effect.
- **C2.** World -> Ordering boundary has not yet been implemented; Menu
  Portal functional hand-off remains future work.
- **C3.** Real Android/touch/low-mid-range device performance has not yet
  been verified.
- **C4.** The prototype uses three visual depth groups rather than
  explicitly implementing the full Z0–Z60 rendering model.
- **C5.** Renderer replacement resilience is structurally designed but not
  empirically tested with a second renderer.

## 18. Explicit Scope Boundary Statement

AWR-01 is a foundation/proof scope only. **The actual AUL World has NOT been
implemented.** The prototype is isolated entirely under `aul-world-runtime/`
and is NOT connected to Firebase, Firestore, Auth, Cloud Functions,
`posSale`, `orderIntent`, payment, the production catalog, or any production
asset. The prototype has NOT been deployed. This checkpoint does not claim
mobile readiness or production readiness.

## 19. Next Authorized Direction

**AWR-02 is NOT authorized by this checkpoint.** It requires separate,
explicit architect authorization before any further implementation work
(External Effects, Ordering boundary, Menu Portal hand-off, real Aul/cats/
world assets, Firebase/Auth/payment integration, or Android device testing)
may begin.
