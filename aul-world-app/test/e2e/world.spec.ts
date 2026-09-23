// U3 browser e2e - "AWR remains unchanged". The Composition reproduces AWR's
// wiring from AWR's public modules; these tests show that, through it, the
// World still behaves exactly as AWR's own e2e (R1-R5) established, and that
// the bundle contains only AWR's allow-listed production modules - none of its
// proof/test artifacts - built from AWR's unmodified source.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AWR, advance, attribute, boot, canvasPoint, expectNoProblems, freezeTime, mount, phase, settleFrames, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

test("P1. (AWR R2) tapping the cat focuses the camera on the cat", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.cat);
  await settleFrames(page);
  expect(await attribute(page, "data-world-camera")).toBe("CAT_FOCUS");
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

test("P2. (AWR R3) tapping Aul makes Aul happy, focuses the camera and counts the interaction", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
  await tapWorld(page, AWR.aul);
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect(await attribute(page, "data-aul-interactions")).toBe("1");
});

test("P3. (AWR R4) tapping the menu portal crosses the World -> Ordering boundary", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.menuPortal);
  await settleFrames(page);
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS");
});

test("P4. (AWR Ordering priority) while ORDERING, world taps do not change AWR - but they are still customer input for the Experience", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.menuPortal);
  await settleFrames(page);
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");

  // MENU_FOCUS is centred on the portal: Aul is drawn elsewhere now; tap where the
  // canvas is, on the empty top-left, and directly at Aul's authored spot.
  await advance(page, 20_000);
  expect(await phase(page)).toBe("SPACE_GIVEN");
  await tapWorld(page, AWR.aul);
  await tapWorld(page, AWR.cat);
  await settleFrames(page);

  // AWR ignored the gestures (its own guard)...
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
  expect(await attribute(page, "data-aul-interactions")).toBe("0");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS");
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  // ...while the Experience counted them as a customer being present.
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
});

test("P5. the AWR World runs alone: no AWR test panel, exactly one canvas at AWR's native size", async ({ page }) => {
  await mount(page);
  expect(await page.locator("#awr-status, #awr-greeting-status, #awr-ordering-status, .awr-dom-panel, .awr-layout").count()).toBe(0);
  const canvas = await canvasPoint(page, { x: 0, y: 0 });
  const box = await page.locator("[data-aul-canvas] canvas").boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(640);
  expect(Math.round(box!.height)).toBe(400);
  expect(canvas.x).toBeCloseTo(box!.x, 0);
});

// ============================================================
// The bundle boundary: only AWR's allow-listed production modules
// ============================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.resolve(HERE, "..", "..", "dist", "e2e", "meta.json");

// The AWR modules the Composition is allowed to bundle: the public state/event/
// behavior/render modules AWR's own bootstrap wires together, plus the one
// renderer adapter allowed to import pixi.js.
const ALLOWED_AWR = new Set([
  "assets/assetBoundary.ts",
  "behavior/reducer.ts",
  "events/bus.ts",
  "ordering/orderingBoundary.ts",
  "ordering/reducer.ts",
  "ordering/types.ts",
  "platform/resize.ts",
  "render/adapter/pixiRendererAdapter.ts",
  "render/renderState.ts",
  "state/depth.ts",
  "state/initialState.ts",
  "state/worldConstants.ts",
  "world/hitTestPipeline.ts",
  "world/interactionContract.ts",
]);
const FORBIDDEN_AWR = ["main.ts", "dom/domPanel.ts", "render/adapter/canvas2dTestAdapter.ts", "ordering/orderingAlt.ts", "render/depthProof.ts", "services/mockGreetingService.ts", "effects/greetingEffect.ts"];

test("P6. the bundle contains only AWR's allow-listed production modules; proof/test artifacts contribute no code", async () => {
  const meta = JSON.parse(fs.readFileSync(META, "utf8"));
  const output = Object.values(meta.outputs as Record<string, any>).find((o) => o.entryPoint);
  const bundledBytes = (relative: string): number => {
    const entry = Object.entries(output.inputs as Record<string, { bytesInOutput: number }>).find(([key]) => key.endsWith(`aul-world-runtime/src/${relative}`));
    return entry ? entry[1].bytesInOutput : 0;
  };

  const awrModules = Object.entries(output.inputs as Record<string, { bytesInOutput: number }>)
    .filter(([key, value]) => key.includes("aul-world-runtime/src/") && value.bytesInOutput > 0)
    .map(([key]) => key.replace(/^.*aul-world-runtime\/src\//, ""));

  for (const module of awrModules) expect(ALLOWED_AWR.has(module), `AWR module ${module} contributed code but is not allow-listed`).toBe(true);
  for (const forbidden of FORBIDDEN_AWR) expect(bundledBytes(forbidden), `${forbidden} must contribute no code`).toBe(0);
  // AWR's URL-parameter proof switches are not honored, so their strings are absent.
  const bundle = fs.readFileSync(path.resolve(HERE, "..", "..", "dist", "e2e", "harness.js"), "utf8");
  for (const marker of ["depth-proof", "renderer=canvas2d", "ordering=alt"]) {
    expect(bundle.includes(marker), `${marker} leaked into the bundle`).toBe(false);
  }
});

test("P7. the Kiosk is bundled from unmodified SOURCE, never from the gitignored kiosk/dist artifact", async () => {
  const meta = JSON.parse(fs.readFileSync(META, "utf8"));
  const inputs = Object.keys(meta.inputs);
  expect(inputs.some((i) => /kiosk\/dist\//.test(i))).toBe(false);
  expect(inputs.some((i) => /kiosk\/browser\/createBrowserKiosk\.js$/.test(i))).toBe(true);
  expect(inputs.some((i) => /kiosk\/runtime\/kioskRuntime\.js$/.test(i))).toBe(true);
  expect(inputs.some((i) => /kiosk\/experience\/experienceProjection\.js$/.test(i))).toBe(true);
});
