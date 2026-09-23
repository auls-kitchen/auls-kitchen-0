// Builds the PRODUCTION Kiosk Experience entry (D3 Step 1 - Production
// Experience Shell Boundary). Mirrors build:e2e's proven structure exactly
// (same esbuild options, same AWR/Kiosk-from-source discipline) - this file
// does not redesign or refactor that tooling, it is a separate, additive
// script for a separate entry point:
//
//   test/e2e/harness/harness.ts  -> dist/e2e   (test infrastructure only)
//   production/main.ts           -> dist/prod  (this script)
//
// One esbuild bundle of production/main.ts, which imports the real
// Composition root, the real AWR modules, and the real, unmodified Kiosk
// source (kiosk/browser/createBrowserKiosk.js and everything it composes) -
// all from SOURCE, so production never depends on a stale gitignored
// kiosk/dist artifact. `build:e2e` itself is untouched by this script.
//
// `nodePaths` lets AWR's own `import "pixi.js"` (in a frozen AWR file whose
// directory has no node_modules) resolve to THIS package's pixi.js, without
// touching AWR - identical reasoning to build:e2e.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "prod");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "production", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: path.join(outDir, "main.js"),
  nodePaths: [path.join(root, "node_modules")],
  metafile: true,
  logLevel: "warning",
});

copyFileSync(path.join(root, "production", "index.html"), path.join(outDir, "index.html"));
writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(result.metafile, null, 2));

console.log(`production Kiosk entry built: ${path.relative(root, path.join(outDir, "main.js"))}`);
