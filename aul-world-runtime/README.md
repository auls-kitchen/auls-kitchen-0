# AUL World Runtime — AWR-01 Prototype

Isolated architecture/engine-selection proof for scope AWR-01. This
directory is a completely separate package (own `package.json`,
`node_modules`, build) and is **not** wired into any production file,
build, or deployment in this repository. Nothing here is connected to
Firebase, Firestore, Auth, payment, `posSale`, or `orderIntent`.

All visuals are placeholder circles — no production Aul, cat, or menu
artwork is used.

## Run locally

```
cd aul-world-runtime
npm install
npm run dev      # local dev server
npm run build    # type-check + production build (dist/, gitignored)
```

## Layout

```
src/
  state/      domain state types + initial state (no rendering-library imports)
  events/     semantic event types + a minimal event bus
  behavior/   the single reducer — the only place state changes
  world/      interaction contract + hit-test-to-event pipeline
  render/
    renderState.ts        pure projection of domain state -> plain render data
    adapter/pixiRendererAdapter.ts   the ONLY file that imports pixi.js
  dom/        plain DOM test panel, independent of the canvas
  assets/     asset-identifier boundary (domain-safe side)
  platform/   resize/infrastructure glue
```
