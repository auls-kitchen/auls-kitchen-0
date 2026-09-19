// Builds the e2e HARNESS page (test infrastructure only - never production,
// never deployed). One esbuild bundle of test/e2e/harness/harness.ts, which
// imports the real Composition root, the real AWR modules, and the real,
// unmodified Kiosk source (kiosk/browser/createBrowserKiosk.js and everything
// it composes) - all from SOURCE, so the e2e never depends on a stale
// gitignored kiosk/dist artifact.
//
// `nodePaths` lets AWR's own `import "pixi.js"` (in a frozen AWR file whose
// directory has no node_modules) resolve to THIS package's pixi.js, without
// touching AWR. The metafile records exactly which modules were bundled so the
// e2e can assert no AWR proof/test artifact slipped in.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "e2e");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "test", "e2e", "harness", "harness.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: path.join(outDir, "harness.js"),
  nodePaths: [path.join(root, "node_modules")],
  metafile: true,
  logLevel: "warning",
});

copyFileSync(path.join(root, "test", "e2e", "harness", "harness.html"), path.join(outDir, "harness.html"));
writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(result.metafile, null, 2));

console.log(`e2e harness built: ${path.relative(root, path.join(outDir, "harness.js"))}`);
