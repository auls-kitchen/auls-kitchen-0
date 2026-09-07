# CHECKPOINT — RT-11: WORLD/ORDERING INDEPENDENT EVOLVABILITY

## Scope: AUL World Runtime — Ordering Implementation Replacement Proof (RT-11)

Date: 2026-09-07

## 1. RT-11 Claim and Scope

Claim: **"World can evolve independently of Ordering's internal
implementation."** More precisely: the existing World↔Ordering semantic
event boundary is a genuine implementation-replacement seam — a second,
internally-genuinely-different Ordering implementation can satisfy the
same contract, with World, the event bus, `RenderState`, and the
renderer adapters completely unchanged.

Scope is strictly the existing World/Ordering boundary already defined
in `ordering/*`, `events/types.ts`, and `behavior/reducer.ts`. RT-11
does not include a real Cart/Product/Payment implementation, Firebase,
Midtrans, Kiosk, POS, production ordering UX, renderer replacement,
Canvas2D adapter cleanup, performance optimization, dependency
upgrades, or physical-device verification.

## 2. Starting State

RT-11 was **OPEN / INFERRED** after AWR-03 first named it, restated
unresolved in AWR-04, and left untracked (neither resolved nor
retracted) through AWR-05 and C5. C6 (committed automated regression
suite, commit `a92aeb5c1974d3cea445dea6f34d99855e3b9a32`) provided the
prerequisite this proof reuses: a repository-resident, repeatable
regression suite (specifically the R4/R5 assertions) that this proof
runs unmodified against a second Ordering implementation.

## 3. Frozen Public Boundary

Held frozen throughout RT-11, verified unchanged at every phase:
- The four event shapes: `MenuIntentEvent`, `OrderingReadyEvent`,
  `OrderingRejectedEvent`, `ReturnToWorldEvent` (`events/types.ts`).
- `OrderingState`'s shape (`{status, rejectionReason}`) and the four
  `OrderingStatus` values (`ordering/types.ts`).
- `RenderState.ordering`'s shape (`render/renderState.ts`).
- The externally observable status transitions for a given event
  sequence.

## 4. Ordering1 (Existing Implementation)

`src/ordering/reducer.ts` and `src/ordering/orderingBoundary.ts` —
unchanged throughout RT-11 (`git diff --stat` on both files is empty
at every phase). Remains the default runtime implementation and
remains fully, independently usable.

## 5. Ordering2 (New, Independent Implementation)

`src/ordering/orderingAlt.ts` (new file, Phase 2):
- `reduceOrderingAlt` — a state-indexed, then event-indexed, declarative
  lookup table (`TRANSITION_TABLE[state.status]?.[event.type]`),
  materially different from Ordering1's flat `switch(event.type)`.
- `decideOrderingOutcomeAlt` — an ordered, data-driven rule list
  evaluated first-match-wins, materially different from Ordering1's
  single `if/else` branch.
- Verified independent by inspection: the file's only imports are
  `import type { OrderingState, OrderingStatus } from "./types"` and
  `import type { AppEvent, MenuIntentEvent } from "../events/types"` —
  both type-only, erased at compile time. Zero import, call, wrap, or
  delegation of `reducer.ts` or `orderingBoundary.ts` anywhere in the
  file (grep-confirmed at Phase 2 and re-confirmed at Phase 6).

## 6. OrderingImplementation Contract

Added to `src/ordering/types.ts` (Phase 2), additive only:
```ts
export interface OrderingImplementation {
  reduceOrdering: (state: OrderingState, event: AppEvent) => OrderingState;
  decideOrderingOutcome: (event: MenuIntentEvent) => AppEvent;
}
```
A type-only construct — erased by `tsc`, zero runtime footprint, no
change to any existing export. Both implementations are compiler-checked
against it via `satisfies`:
```ts
export const ordering1Contract = { reduceOrdering, decideOrderingOutcome } satisfies OrderingImplementation;
export const orderingAltContract = { reduceOrdering: reduceOrderingAlt, decideOrderingOutcome: decideOrderingOutcomeAlt } satisfies OrderingImplementation;
```
`tsc --noEmit` passing at every phase confirms both implementations
satisfy the identical named contract objectively, not by inspection alone.

## 7. Composition

`src/main.ts` (Phase 4), one disclosed, minimal, opt-in branch —
directly mirroring the pre-existing `?renderer=canvas2d` (C5) pattern:
```ts
const useOrderingAlt = new URLSearchParams(window.location.search).get("ordering") === "alt";
const activeOrdering = useOrderingAlt ? orderingAltContract : ordering1Contract;
```
- **No URL parameter → Ordering1** (default, behaviorally identical to
  pre-RT-11).
- **`?ordering=alt` → Ordering2.**
- The existing `?renderer=canvas2d` selection remains fully independent
  — both flags read separately from `window.location.search`; empirically
  confirmed non-interacting in Phase 4 (Ordering resolves correctly under
  `?renderer=canvas2d` with default Ordering1, and both flags can be
  combined without conflict).

## 8. World Immutability

The following remained unchanged throughout every RT-11 phase, verified
via `git diff --stat` returning empty at each phase gate:
- `src/behavior/reducer.ts`
- `src/events/types.ts`, `src/events/bus.ts`
- `src/render/renderState.ts`
- `src/render/adapter/pixiRendererAdapter.ts`
- `src/render/adapter/canvas2dTestAdapter.ts`
- `src/ordering/reducer.ts`, `src/ordering/orderingBoundary.ts`
- All pre-existing test files (`test/unit/reducer.test.ts`,
  `orderingReducer.test.ts`, `orderingBoundary.test.ts`, `depth.test.ts`,
  `renderState.test.ts`, `test/e2e/depthProof.spec.ts`)
- `package.json`, `package-lock.json`, `vitest.config.ts`,
  `playwright.config.ts`, `tsconfig.json`, `vite.config.ts`,
  `index.html`, `.github/workflows/aul-world-pages-preview.yml`

## 9. Unit Equivalence

`test/unit/orderingAlt.test.ts` (new, Phase 3): 44 tests total —
- 16 owned-event behavior tests (4 event types × 4 `OrderingStatus`
  starting states)
- 4 unrelated-event (`TICK`) pass-through tests (1 per status)
- 2 `decideOrderingOutcomeAlt` direct tests
- **22 explicit equivalence assertions** comparing `reduceOrderingAlt`
  vs. `reduceOrdering` (16 owned-event + 4 pass-through) and
  `decideOrderingOutcomeAlt` vs. `decideOrderingOutcome` (2), each via
  deep (`toEqual`) comparison of the complete returned public-contract
  value.

Result: **22/22 equivalence assertions PASS**, zero mismatch. Total
unit suite: **93/93 PASS** (49 pre-existing C6 tests + 44 RT-11 tests),
confirmed at Phase 3 and re-confirmed at Phase 6.

## 10. Browser Replacement Experiment

`test/e2e/awr.spec.ts` (extended, Phase 5): R4/R5's assertion logic was
extracted once into two shared functions, `runR4(page)`/`runR5(page)`
— moved verbatim, not altered — then invoked by both:
- **Experiment A** — default boot (no `ordering` param) → Ordering1 →
  `runR4`/`runR5` (also exercised, as before, under both the PixiJS and
  Canvas2D renderer variants in the pre-existing suite).
- **Experiment B** — `?ordering=alt` boot → Ordering2 → the identical
  `runR4`/`runR5` functions.

Both experiments execute the exact same assertion bodies with zero
ordering-specific branching.

## 11. R4/R5 Assertion Identity

Confirmed byte-identical by direct diff inspection at Phase 5 and
Phase 6: the `expect(...)` statements inside `runR4`/`runR5` are
character-for-character the same content that previously lived inline
in the two `test("R4...")`/`test("R5...")` blocks — only their lexical
location moved into named functions; no assertion was added, removed,
loosened, or made conditional on the ordering variant.

## 12. E2E Results

`npx playwright test`: **20/20 PASS, 0 failed, 0 retries** —
16 pre-existing tests (R1–R7 × {pixijs, canvas2d} + 2 depth-proof tests)
plus 4 new tests (R4/R5 × {ordering1, ordering2}). The Ordering2
(`?ordering=alt`) R4/R5 run produced identical observable outcomes to
Ordering1's run: `mode=MENU_FOCUS`/`presentation=ORDERING`/
`ordering=ready` for R4; `mode=WORLD_VIEW`/`presentation=WORLD`/
`ordering=idle` for R5. Confirmed stable across repeated runs during
Phases 5 and 6 (identical results each time).

## 13. Full Verification

| Command | Result |
|---|---|
| `npm run test:unit` | 93/93 PASS |
| `npm run test:e2e` | 20/20 PASS, 0 retries |
| `npm test` (combined) | 93 unit + 20 E2E, all PASS |
| `npx tsc --noEmit -p tsconfig.json` | PASS, 0 errors |
| `npm run build` | PASS (unchanged bundle shape from Phase 4 onward) |

## 14. Falsification Criteria

All 15 RT-11 FAIL conditions (per the approved STEP 34 blueprint) were
checked at every phase gate. **None were triggered:**
1. World code changed — NOT TRIGGERED.
2. `behavior/reducer.ts` changed — NOT TRIGGERED.
3. `events/types.ts` changed — NOT TRIGGERED.
4. Event names/shapes changed — NOT TRIGGERED.
5. `RenderState` implementation changed — NOT TRIGGERED.
6. Renderer adapter changed — NOT TRIGGERED.
7. Existing R4/R5 assertions weakened — NOT TRIGGERED.
8. Ordering2 delegates actual decisions to Ordering1 — NOT TRIGGERED.
9. Ordering2 is only cosmetic — NOT TRIGGERED.
10. Ordering1 became unusable — NOT TRIGGERED.
11. Default runtime behavior changed — NOT TRIGGERED.
12. Firebase introduced — NOT TRIGGERED.
13. Production test hooks/instrumentation introduced — NOT TRIGGERED.
14. Hidden dependency between World and Ordering2 appeared — NOT TRIGGERED.
15. Equivalent event sequence produced different observable results — NOT TRIGGERED.

## 15. Acceptance Matrix

| Criterion | Status | Evidence |
|---|---|---|
| RT11-1 — genuinely different implementation exists | PASS | `orderingAlt.ts`'s table-driven reducer / rule-list boundary decision (Section 5) |
| RT11-2 — satisfies existing semantic contract | PASS | `orderingAltContract satisfies OrderingImplementation` type-checks (Section 6) |
| RT11-3 — World-facing code unchanged | PASS | `git diff --stat` empty on all files in Section 8 |
| RT11-4 — event contract unchanged | PASS | `git diff --stat -- events/types.ts` empty |
| RT11-5 — R4/R5 execute against Ordering2 unweakened | PASS | Section 10–11, Experiment B |
| RT11-6 — behavioral outcomes equivalent | PASS | 22/22 unit equivalence assertions (Section 9) + identical E2E outcomes (Section 12) |
| RT11-7 — no production test hook/instrumentation | PASS | `orderingAlt.ts` is a plain module; `main.ts`'s branch mirrors the pre-existing C5 pattern |
| RT11-8 — regression suite proves the replacement | PASS | Section 13, full suite green |
| RT11-9 — Ordering1 remains intact/independently usable | PASS | Section 4; default boot still uses and passes against Ordering1 |
| RT11-10 — checkpoint states EMPIRICALLY PROVEN | PASS | This document |

## 16. Empirical Conclusion

**Proven:** for the tested contract and regression surface (the four
semantic events, the `OrderingState` shape, and the R4/R5 behavioral
assertions), the World↔Ordering boundary is empirically resilient to
replacement of Ordering's internal implementation — a second,
independently-written implementation using a materially different
internal architecture (declarative transition table vs. imperative
switch; rule-list vs. if/else) produces indistinguishable externally
observable behavior, with zero change required to World, the event
bus, `RenderState`, or either renderer adapter.

**NOT claimed:** that every possible future Ordering implementation
(in particular a real Cart/Product/Payment/Firebase-backed one) will
necessarily integrate without any World-side change; that Ordering is
universally independent of every conceivable integration point; or
that this proof extends beyond the specific four-event, two-function
contract exercised here. RT-11 proves the boundary as currently
defined is a real seam — it does not certify any particular future
Ordering implementation sight unseen.

## 17. C5 Relationship

RT-11 follows the same replacement-proof principle established by C5
(swap the implementation behind an existing boundary, re-run the same
regression assertions unmodified, keep the original fully intact) and
reuses its opt-in URL-flag composition pattern. It does not copy C5's
`RendererAdapter` lifecycle design (`init`/`render`/`onObjectPointerDown`/
`destroy`) — Ordering's actual contract is two stateless pure functions
with no lifecycle, so RT-11's second-implementation and equivalence-test
design was derived independently for that simpler shape, formalized via
the new `OrderingImplementation` interface (Section 6) rather than an
adapted copy of `RendererAdapter`.

## 18. Known Deferred Housekeeping (not resolved by RT-11)

- `canvas2dTestAdapter.ts` remains intentionally retained: C6's E2E
  coverage actively exercises it (9 of 20 E2E tests as of this
  checkpoint), so its removal is no longer risk-free housekeeping — it
  is not touched or resolved by RT-11.
- `orderingAlt.ts` is, by the same pattern, an intentionally retained,
  inert, opt-in-only proof module going forward — not removed as part
  of this checkpoint's closure.
Neither is silently removed here; both remain open items for a future,
separately-authorized housekeeping scope if ever desired.

## 19. Repository Safety

- C6 baseline commit: `a92aeb5c1974d3cea445dea6f34d99855e3b9a32`
  (unaffected by RT-11; all 12 of its files remain unchanged).
- `firebase.json` and `firestore.rules` are standing, pre-existing
  EMU-4 artifacts, unrelated to and untouched by RT-11 — confirmed
  unstaged/untracked and unmodified at every phase gate, including at
  the writing of this checkpoint.

## 20. Closure

**RT-11 CLOSED — EMPIRICALLY PROVEN**

Next scope may be determined separately after this checkpoint is
reviewed. No next scope is proposed, inferred, or authorized by this
document.
