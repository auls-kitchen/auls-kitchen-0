# CHECKPOINT — AWR-03: WORLD → ORDERING BOUNDARY PROOF

## Scope: AUL World Runtime — World → Ordering Boundary Proof (AWR-03)

Date: 2026-09-06

## 1. Checkpoint Identity

- Scope name: AWR-03 (World → Ordering Boundary Proof)
- Date: 2026-09-06
- Status: **CLOSED**
- Architect decision: **PASS**
- Branch: main
- HEAD at closure commit's parent: `3f57b39caf04c71c926d4ade6e884703af1f28c7` (AWR-02 checkpoint)
- This checkpoint's own commit becomes the new HEAD once pushed.

## 2. AWR-01 Condition Addressed

**C2 — PROVEN for the defined AWR-03 mock Ordering boundary.**

AWR-01 condition C2 ("World → Ordering boundary has not yet been
implemented; Menu Portal functional hand-off remains future work") is
proven within the scope of this proof. AWR-03 is an architectural proof
scope only — it does not build the real Kiosk ordering system, a real
catalog, cart, or payment flow.

## 3. Verified Boundary

```
WORLD
-> MENU_INTENT
-> ORDERING BOUNDARY
-> ORDERING STATE
-> ORDERING_READY / ORDERING_REJECTED
-> WORLD RESPONSE
-> STATE
-> RENDER
```

Implemented as: a Menu Portal (semantic Portal-class world object, id
`menu_portal`) interaction runs through the existing AWR-01 pipeline
(hit test -> object id -> interaction contract -> intent) and, because
its intent is `OPEN_PORTAL`, emits `MENU_INTENT` instead of the generic
`OBJECT_INTERACTED` event used by every other intent. `main.ts` routes
`MENU_INTENT` to `ordering/orderingBoundary.ts`'s `decideOrderingOutcome`,
which emits `ORDERING_READY` or `ORDERING_REJECTED` back onto the shared
event bus. World's own reducer reacts to that result by entering/leaving
"Ordering" presentation mode and moving the camera; Ordering's own,
independent reducer tracks its own `idle/requested/ready/rejected` status.
`RETURN_TO_WORLD` reverses the transition.

## 4. What Was Verified

- **Menu Portal semantic Portal interaction** — the portal remains a
  plain `WorldObject` (id `menu_portal`, class `Portal`); no special-case
  object-id branching was introduced. Routing to `MENU_INTENT` is decided
  by the object's CLASS (via the existing `interactionContract.ts` ->
  `OPEN_PORTAL` intent), so any future Portal-class object would behave
  identically.
- **Hit test identifies `menu_portal`** — OBSERVED via a genuine canvas
  pointer click at the portal's authored world position (460, 250), not a
  DOM shortcut.
- **Portal interaction produces MENU_INTENT** — OBSERVED: event log
  recorded `MENU_INTENT via canvas (forceReject=false)`.
- **Ordering has an independent OrderingState** — `ordering/types.ts`
  defines `OrderingState { status, rejectionReason }`, entirely separate
  from `WorldState` (no nesting, no shared object).
- **Ordering reducer owns OrderingState / World reducer owns WorldState**
  — two independent pure reducer functions (`ordering/reducer.ts` and
  `behavior/reducer.ts`), each called once per event from `main.ts`, each
  only ever assigning to its own state slice.
- **Ordering does not import WorldState** — grep-verified zero reference
  to `state/types.ts`/`WorldState` anywhere under `ordering/`.
- **World does not import Ordering internals** — grep-verified World's
  reducer, hit-test pipeline, and interaction contract contain no real
  import of `ordering/reducer.ts` or `ordering/orderingBoundary.ts` (only
  `main.ts`, the composition root, imports both).
- **Semantic result events cross the boundary** — `ORDERING_READY` and
  `ORDERING_REJECTED` carry no UI/renderer implementation detail; `reason`
  on rejection is a semantic string (`"test_rejection"`), not a stack
  trace or internal error object.
- **ORDERING_READY path** — OBSERVED: World transitions to
  `presentation=ORDERING`, camera to `MENU_FOCUS` (reusing the existing
  AWR-01 `focusTargetForMode` helper); Ordering transitions to `ready`.
- **ORDERING_REJECTED path** — OBSERVED via the deterministic
  `forceReject` test control: World stays at `presentation=WORLD` (never
  partially entered Ordering), Ordering records `rejected` with the
  reason; World remained fully interactive immediately afterward (a
  genuine canvas tap on Aul still correctly produced `AUL_FOCUS`).
- **RETURN_TO_WORLD path** — OBSERVED: from an active Ordering session,
  `RETURN_TO_WORLD` fully restores `presentation=WORLD`, `mode=WORLD_VIEW`.
- **Ordering priority over non-essential World interaction** — OBSERVED:
  while `presentation=ORDERING`, a genuine canvas tap on Aul and a click
  on the "Camera: Aul Focus" DOM control both left camera/HUD state
  unchanged (guarded in `behavior/reducer.ts`'s `OBJECT_INTERACTED` and
  `CAMERA_FOCUS_REQUESTED` cases); the explicit "Return to World" control
  remained functional throughout and was not blocked by this guard.
- **Camera remains a World/presentation concern** — Ordering never calls
  any camera method; all camera transitions happen inside World's own
  reducer in response to the semantic `ORDERING_READY`/`RETURN_TO_WORLD`
  events.
- **Renderer remains outside Ordering** — grep-verified zero `pixi`
  reference anywhere under `ordering/`; the renderer adapter was not
  modified by this scope.
- **DOM does not bypass the semantic event boundary** — grep-verified
  `dom/domPanel.ts`'s new controls only call `bus.emit(...)`; no import of
  `ordering/reducer.ts` or `ordering/orderingBoundary.ts`.
- **Event bus remains thin** — `events/bus.ts` was not modified; still the
  same minimal subscribe/emit function.
- **No Firebase/Firestore/Auth, no payment, no orderIntent, no posSale**
  — grep-verified zero real reference anywhere in the whole prototype (all
  matches were comments describing the boundary).
- **No production impact** — `git diff --stat` against every production
  file (`aul-pos.html`, `aul-adm.html`, `index.html`,
  `customer-display.html`, `auls-kitchen-menu.html`, `functions/`,
  `.firebaserc`, and both prior checkpoint files) is empty.
- **No deployment** — not deployed, not published; verification used only
  a local Vite preview server, stopped afterward.

Static verification also confirmed: `tsc --noEmit` PASS, `vite build`
PASS, zero new dependencies added (`package.json` unchanged: `pixi.js`
runtime; `typescript`/`vite` dev), no giant file created (largest file
`behavior/reducer.ts` at 194 lines), and exactly one file in the entire
prototype imports `pixi.js` (the pre-existing renderer adapter,
unmodified by this scope).

## 5. Architectural Notes (preserved, not resolved)

- **Synchronous re-entrant `bus.emit` is a scoped note, not a universal
  standard.** The minimal `MENU_INTENT -> decideOrderingOutcome -> result
  event` proof routes through a synchronous, re-entrant call to the same
  `bus.subscribe` listener (unlike AWR-02's effect routing, which was
  inherently non-reentrant because its result arrived after a real
  `Promise`/`setTimeout` boundary). This is empirically verified as
  harmless for this scope — every runtime test confirms the final state
  is correct — but it is **not** declared a universal cross-domain
  communication standard. A future scope introducing an additional
  cross-domain boundary may revisit whether a different dispatch shape
  (e.g., an async decision function, matching AWR-02's precedent) is
  preferable.
- **RT-11 remains INFERRED, not proven.** "World can evolve independently
  of Cart/Product/Payment implementation" is a structural inference from
  the fact that World's only contact with Ordering is four semantic
  events containing no business data — it has **not** been empirically
  proven with a second, differently-implemented Ordering module. This
  checkpoint does not claim RT-11 as proven.

## 6. Files Created (AWR-03)

```
aul-world-runtime/src/ordering/types.ts
aul-world-runtime/src/ordering/reducer.ts
aul-world-runtime/src/ordering/orderingBoundary.ts
```

## 7. Files Modified (AWR-03)

```
aul-world-runtime/src/state/types.ts
aul-world-runtime/src/state/initialState.ts
aul-world-runtime/src/events/types.ts
aul-world-runtime/src/behavior/reducer.ts
aul-world-runtime/src/world/hitTestPipeline.ts
aul-world-runtime/src/render/renderState.ts
aul-world-runtime/src/dom/domPanel.ts
aul-world-runtime/src/main.ts
```

All modifications are additive except one contained identifier rename
(`"portal-menu"` → `"menu_portal"`, required by this scope's blueprint,
updated at all 3 pre-existing call sites together). No existing AWR-01/
AWR-02 event, state field, or behavior was removed. No file outside
`aul-world-runtime/` was modified.

## 8. Production Safety

- No production file was modified: `aul-pos.html`, `aul-adm.html`,
  `index.html`, `customer-display.html`, `auls-kitchen-menu.html`,
  `functions/`, `.firebaserc` are all unchanged.
- No Firebase project, Firestore data, Firestore Security Rules, Cloud
  Function, Firebase Auth, payment integration, or Cloudflare
  configuration was touched.
- No deployment of any kind occurred.

## 9. Standing Local Files

```
 M firebase.json
?? firestore.rules
```
These remain the pre-existing, EMU-4, local-emulator-only artifacts —
unrelated to and unaffected by this checkpoint. They are not committed by
this or any prior checkpoint in this series.

## 10. AWR-01 Conditions Status (after AWR-03)

- **C1 — ADDRESSED** (from AWR-02, unchanged by this scope).
- **C2 — PROVEN** for the defined AWR-03 mock Ordering boundary (see
  Sections 2–4). RT-11's broader claim of independent evolvability
  remains INFERRED, not proven (Section 5).
- **C3 — OPEN.** Real Android/touch/low-mid-range device performance has
  not been verified.
- **C4 — OPEN.** The prototype still uses three visual depth groups
  rather than the full Z0–Z60 rendering model.
- **C5 — OPEN.** Renderer replacement resilience remains structurally
  argued, not empirically tested with a second renderer.

## 11. Explicit Scope Boundary Statement

This checkpoint does **not** claim mobile readiness, production
readiness, or that the real AUL World or a real Kiosk ordering system has
been built. AWR-03 remains a placeholder-only architectural proof
confined to `aul-world-runtime/`, with zero connection to Firebase,
Firestore, Auth, Cloud Functions, `posSale`, `orderIntent`, payment, the
production catalog, or any production asset.

## 12. Next Authorized Direction

**AWR-04 is NOT authorized by this checkpoint.** It requires separate,
explicit architect authorization before any further implementation work
may begin.
