import { test, expect } from "@playwright/test";

// C6 Phase 3: browser regression test for the existing AWR-05 depth
// proof scene (?depth-proof=1). Ported from the manually-executed
// gate5_proof.mjs script for the default (PixiJS) boot path.
//
// Design note (disclosed, not silent): the default boot path renders
// through PixiJS's WebGL canvas, whose backing buffer is not reliably
// readable pixel-by-pixel from outside the renderer without a
// production-code change (e.g. forcing `preserveDrawingBuffer: true`
// on the PixiJS Application) — which this phase is not authorized to
// make. So the default-renderer test below verifies exactly what the
// original AWR-05 gate script verified: canvas presence, the
// overlay's exact existing text, HUD state, and zero unexpected
// errors — no screenshot, no pixel-diff baseline.
//
// A second, additive check proves the actual Z0-Z60 semantic draw
// order programmatically: `?depth-proof=1` is combined with the
// already-existing, independent `?renderer=canvas2d` opt-in (C5),
// whose canvas is a plain 2D canvas — the exact same
// getImageData-based pixel-sampling technique already used and proven
// during the C5 Canvas2D regression check is reused here, unmodified
// in method, applied to the depth-proof scene. This is not a new
// visual metric and not a screenshot/snapshot comparison — it is a
// small number of single-point deterministic color reads.

const DEPTH_PROOF_QUERY = "?depth-proof=1";
const DEPTH_PROOF_CANVAS2D_QUERY = "?depth-proof=1&renderer=canvas2d";

// Proof scene geometry and colors, from src/render/depthProof.ts —
// PROOF_CENTER (320,200), which coincides with the canvas/world center,
// so the default WORLD_VIEW camera (zoom=1, centered) maps it to canvas
// pixel (320,200) unchanged.
const CENTER = { x: 320, y: 200 };
const Z60_COLOR = [0xe6, 0x39, 0x46]; // topmost, radius 30
const Z10_COLOR = [0x57, 0x75, 0x90]; // radius 80, visible at mid-radius once Z20 (radius 70) no longer covers
const BACKGROUND_COLOR = [0x0e, 0x14, 0x20];

async function samplePixel(page: import("@playwright/test").Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const data = ctx.getImageData(x, y, 1, 1).data;
      return [data[0], data[1], data[2]];
    },
    { x, y },
  );
}

test.describe("AWR-05 depth proof (?depth-proof=1)", () => {
  let errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });
  });

  test.afterEach(() => {
    const unexpected = errors.filter((e) => !e.includes("404"));
    expect(unexpected, `unexpected console/page errors: ${JSON.stringify(unexpected)}`).toEqual([]);
  });

  test("default (PixiJS) boot: canvas, overlay, and HUD are present as already validated", async ({ page }) => {
    await page.goto(DEPTH_PROOF_QUERY, { waitUntil: "networkidle" });
    await page.waitForSelector("canvas", { timeout: 10000 });
    await page.waitForTimeout(300);

    await expect(page.locator("canvas")).toBeVisible();

    const bodyText = await page.content();
    expect(bodyText).toContain("AWR-05 DEPTH PROOF");

    const overlayText = await page.evaluate(() => {
      const pres = [...document.querySelectorAll("pre")];
      const match = pres.find((p) => p.textContent?.includes("AWR-05 DEPTH PROOF"));
      return match ? match.textContent : null;
    });
    // Exact existing overlay content (hardcoded, independent display
    // list — src/render/depthProof.ts), unchanged since AWR-05.
    expect(overlayText).toBe(["AWR-05 DEPTH PROOF", "", "Z60", "Z50", "Z40", "Z30", "Z20", "Z10", "Z0"].join("\n"));

    // The normal HUD is still driven by the underlying WorldState
    // (createDepthProofState only swaps `objects`), so it should read
    // exactly like a normal boot.
    const status = await page.textContent("#awr-status");
    expect(status).toContain("mode=WORLD_VIEW");
    expect(status).toContain("presentation=WORLD");
  });

  test("canvas2d boot: Z0-Z60 draw order is provably correct via pixel sampling", async ({ page }) => {
    await page.goto(DEPTH_PROOF_CANVAS2D_QUERY, { waitUntil: "networkidle" });
    await page.waitForSelector("canvas", { timeout: 10000 });
    await page.waitForTimeout(300);

    // Center: every one of the 7 proof objects covers this point; the
    // correct (numeric-z-driven) draw order must show Z60 — the
    // smallest, highest-z, last-drawn object — on top. If the
    // renderer instead used array/insertion order (the exact
    // regression this scene is designed to catch), Z0 (the largest
    // circle) would cover everything and this pixel would show Z0's
    // color instead.
    const centerPixel = await samplePixel(page, CENTER.x, CENTER.y);
    expect(centerPixel).toEqual(Z60_COLOR);

    // Mid-radius point (75px right of center): only Z0 (radius 90) and
    // Z10 (radius 80) cover this point (Z20's radius 70 does not); the
    // correct order shows Z10 (higher z) on top of Z0.
    const midRingPixel = await samplePixel(page, CENTER.x + 75, CENTER.y);
    expect(midRingPixel).toEqual(Z10_COLOR);

    // Outside every ring (95px right of center, beyond Z0's radius 90):
    // the plain background color must show through.
    const outsidePixel = await samplePixel(page, CENTER.x + 95, CENTER.y);
    expect(outsidePixel).toEqual(BACKGROUND_COLOR);
  });
});
