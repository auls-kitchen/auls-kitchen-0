# CHECKPOINT — AWR-02: EXTERNAL EFFECTS BOUNDARY PROOF

## Scope: AUL World Runtime — External Effects Boundary Proof (AWR-02)

Date: 2026-09-06

## 1. Checkpoint Identity

- Scope name: AWR-02 (External Effects Boundary Proof)
- Date: 2026-09-06
- Status: **CLOSED**
- Architect decision: **PASS**
- Branch: main
- HEAD at closure commit's parent: `5b44cd158bbe5a34d773d304c4153f894b8d0753` (AWR-01 checkpoint)
- This checkpoint's own commit becomes the new HEAD once pushed.

## 2. AWR-01 Condition Addressed

**C1 — ADDRESSED.**

AWR-01 condition C1 ("External Effects pattern has not yet been exercised
with a representative mock effect") is addressed by this scope. AWR-02 is
an architectural proof scope only — it is not feature development, and it
does not build the real AUL World or integrate any production service.

## 3. Verified Flow

```
EVENT
-> DISPATCH
-> REDUCER
-> EFFECT
-> EXTERNAL SYSTEM
-> RESULT EVENT
-> REDUCER
-> STATE
-> RENDER
```

Implemented as: a DOM button emits `AUL_GREETING_REQUESTED` -> the single
existing `bus.subscribe` dispatcher in `main.ts` reduces it synchronously
(state moves to `pending` immediately) and separately routes it to
`effects/greetingEffect.ts` -> that effect calls
`services/mockGreetingService.ts` (a genuine `Promise`/`setTimeout` async
boundary) -> the mock resolves or rejects -> the effect emits
`AUL_GREETING_READY` or `AUL_GREETING_FAILED` back onto the same bus -> the
same reducer handles the result -> state changes (`success`/`failure`,
Aul's mood) -> `render/renderState.ts` derives the new `RenderState` ->
canvas (Aul recolors) and DOM (status panel) both reflect the result.

## 4. What Was Verified

- **Asynchronous mock external service** — `services/mockGreetingService.ts`
  uses a real `Promise` + `setTimeout` (500ms simulated latency), not a
  same-tick function call disguised as async.
- **Success path** — OBSERVED via headless-Chromium/Playwright: request ->
  immediate `pending` -> resolves to `success` with a real message from the
  mock -> Aul's canvas circle recolors to "happy" (reusing AWR-01's
  existing mood-to-color render logic, no adapter changes needed).
- **Failure path** — OBSERVED: request -> immediate `pending` -> resolves
  to `failure` with the mock's rejection reason -> Aul's mood returns to
  `idle` (calm/recovery state) -> world remained fully interactive
  immediately afterward (canvas hit-testing and camera focus still worked).
- **Retry path** — OBSERVED: after a failure, a fresh request produces a
  new pending state and a new, different success result — confirmed to be
  a genuinely new async call, not a replayed/cached one.
- **Stale async response protection via requestId** — a monotonically
  increasing `requestId`, owned by the reducer, is echoed back by the
  effect/service and checked on every result event; a stale result whose
  `requestId` no longer matches the current one is discarded. This was
  empirically exercised with a deliberate rapid double-click race (failure
  request immediately followed by a success request): the stale failure
  result was correctly ignored (event log recorded
  `AUL_GREETING_FAILED ignored (stale requestId 4)`), and the final state
  correctly reflected the later, successful request.
- **Reducer remains sole state owner** — grep-verified: neither
  `effects/greetingEffect.ts` nor `services/mockGreetingService.ts`
  contains any reference to the domain `state` object; both only pass
  plain request/result data across the boundary.
- **Service/effect do not access state** — confirmed by the same grep
  evidence above.
- **DOM emits semantic events only** — grep-verified: `dom/domPanel.ts`
  contains no import of `greetingEffect` or `mockGreetingService`; its two
  new buttons only call `bus.emit({type:"AUL_GREETING_REQUESTED", ...})`.
- **Renderer does not execute effects** — the renderer adapter was not
  modified in this scope and has no reference to `effects/` or `services/`.
- **Result events return through the same event/reducer pipeline** — both
  `AUL_GREETING_READY` and `AUL_GREETING_FAILED` are handled by the same
  `reduce()` switch statement as every other event, via the same
  `bus.subscribe` call in `main.ts`.
- **Runtime remains usable after effect failure** — OBSERVED: clicking the
  Aul placeholder on canvas immediately after a failed effect still
  correctly triggered `AUL_FOCUS` camera mode.
- **Zero Firebase/Firestore integration** — grep-verified no real
  Firebase/Firestore references anywhere in `aul-world-runtime/src`.
- **Zero production impact** — `git diff --stat` against every production
  file (`aul-pos.html`, `aul-adm.html`, `index.html`,
  `customer-display.html`, `auls-kitchen-menu.html`, `functions/`,
  `.firebaserc`) is empty.
- **No deployment** — not deployed, not published; only run locally via
  `npm run preview` for verification, stopped afterward.

Static verification also confirmed: `tsc --noEmit` PASS, `vite build`
PASS, zero new dependencies added (`package.json` unchanged:
`pixi.js` runtime; `typescript`/`vite` dev), no giant file created
(largest file `behavior/reducer.ts` at 146 lines), and exactly one file in
the entire prototype imports `pixi.js` (the pre-existing renderer adapter,
unmodified by this scope).

## 5. Files Created (AWR-02)

```
aul-world-runtime/src/effects/greetingEffect.ts
aul-world-runtime/src/services/mockGreetingService.ts
```

## 6. Files Modified (AWR-02)

```
aul-world-runtime/src/state/types.ts
aul-world-runtime/src/state/initialState.ts
aul-world-runtime/src/events/types.ts
aul-world-runtime/src/behavior/reducer.ts
aul-world-runtime/src/render/renderState.ts
aul-world-runtime/src/dom/domPanel.ts
aul-world-runtime/src/main.ts
```

All modifications are additive. No existing AWR-01 event, state field, or
behavior was removed or renamed. No file outside `aul-world-runtime/` was
modified by the AWR-02 implementation.

## 7. Production Safety

- No production file was modified: `aul-pos.html`, `aul-adm.html`,
  `index.html`, `customer-display.html`, `auls-kitchen-menu.html`,
  `functions/`, `.firebaserc` are all unchanged.
- No Firebase project, Firestore data, Firestore Security Rules, Cloud
  Function, Firebase Auth, payment integration, or Cloudflare
  configuration was touched.
- No deployment of any kind occurred.

## 8. Standing Local Files

```
 M firebase.json
?? firestore.rules
```
These remain the pre-existing, EMU-4, local-emulator-only artifacts —
unrelated to and unaffected by this checkpoint. They are not committed by
this or any prior checkpoint in this series.

## 9. AWR-01 Conditions Status (after AWR-02)

- **C1 — ADDRESSED** by this scope (see Sections 2–4).
- **C2 — OPEN.** World -> Ordering boundary has not been implemented.
- **C3 — OPEN.** Real Android/touch/low-mid-range device performance has
  not been verified.
- **C4 — OPEN.** The prototype still uses three visual depth groups rather
  than the full Z0–Z60 rendering model.
- **C5 — OPEN.** Renderer replacement resilience remains structurally
  argued, not empirically tested with a second renderer.

## 10. Explicit Scope Boundary Statement

This checkpoint does **not** claim mobile readiness, production readiness,
or that the real AUL World has been built. AWR-02 remains a placeholder-only
architectural proof confined to `aul-world-runtime/`, with zero connection
to Firebase, Firestore, Auth, Cloud Functions, `posSale`, `orderIntent`,
payment, the production catalog, or any production asset.

## 11. Next Authorized Direction

**AWR-03 is NOT authorized by this checkpoint.** It requires separate,
explicit architect authorization before any further implementation work
may begin.
