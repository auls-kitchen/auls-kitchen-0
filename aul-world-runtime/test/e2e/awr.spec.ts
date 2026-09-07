import { test, expect, type Page } from "@playwright/test";

// C6 Phase 3: browser/runtime regression tests, ported directly from
// the manually-executed AWR-04/05/C5 gate scripts (R1-R7). Run against
// both the default PixiJS renderer and the existing ?renderer=canvas2d
// opt-in (C5), reusing the SAME assertions for both — proving
// behavioral parity, not adding a second test suite. No production
// file is imported, modified, or referenced beyond its existing URL
// opt-in behavior.

const RENDERERS = [
  { label: "pixijs (default)", query: "" },
  { label: "canvas2d (?renderer=canvas2d)", query: "?renderer=canvas2d" },
];

async function hud(page: Page): Promise<string> {
  return (await page.textContent("#awr-status")) ?? "";
}

async function orderingStatus(page: Page): Promise<string> {
  return (await page.textContent("#awr-ordering-status")) ?? "";
}

async function eventLog(page: Page): Promise<string[]> {
  return page.locator("#awr-log li").allTextContents();
}

// Authored world coordinates, unchanged since AWR-01/03 and reused
// identically across every prior gate script this session.
const CAT = { x: 340, y: 320 };
const AUL = { x: 200, y: 310 };
const MENU_PORTAL = { x: 460, y: 250 };

async function clickWorldPoint(page: Page, point: { x: number; y: number }): Promise<void> {
  const canvas = page.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas bounding box not available");
  await page.mouse.click(box.x + point.x, box.y + point.y);
}

for (const renderer of RENDERERS) {
  test.describe(`AWR regression — ${renderer.label}`, () => {
    let errors: string[] = [];

    test.beforeEach(async ({ page }) => {
      errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
      });
      await page.goto(renderer.query, { waitUntil: "networkidle" });
      await page.waitForSelector("canvas", { timeout: 10000 });
      await page.waitForTimeout(300);
    });

    test.afterEach(() => {
      // The only accepted exception, consistent with every prior AWR
      // gate this session: the browser's automatic favicon 404 (no
      // favicon is defined by index.html). Any other error fails the
      // test — errors are never silently swallowed.
      const unexpected = errors.filter((e) => !e.includes("404"));
      expect(unexpected, `unexpected console/page errors: ${JSON.stringify(unexpected)}`).toEqual([]);
    });

    test("R1: boot / runtime initialization", async ({ page }) => {
      await expect(page.locator("canvas")).toBeVisible();
      const status = await hud(page);
      expect(status).toContain("mode=WORLD_VIEW");
      expect(status).toContain("aul=idle");
      expect(status).toContain("interactions=0");
      expect(status).toContain("presentation=WORLD");
      expect(status).toContain("ordering=idle");
    });

    test("R2: Cat interaction", async ({ page }) => {
      await clickWorldPoint(page, CAT);
      await page.waitForTimeout(150);
      expect(await hud(page)).toContain("mode=CAT_FOCUS");
      const log = await eventLog(page);
      expect(log.some((line) => line.includes("OBJECT_INTERACTED(cat-1)"))).toBe(true);
    });

    test("R3: Aul interaction", async ({ page }) => {
      await clickWorldPoint(page, AUL);
      await page.waitForTimeout(150);
      const status = await hud(page);
      expect(status).toContain("mode=AUL_FOCUS");
      expect(status).toContain("aul=happy");
      expect(status).toContain("interactions=1");
    });

    test("R4: World -> Ordering boundary (Menu Portal)", async ({ page }) => {
      await clickWorldPoint(page, MENU_PORTAL);
      await page.waitForTimeout(150);
      const status = await hud(page);
      expect(status).toContain("mode=MENU_FOCUS");
      expect(status).toContain("presentation=ORDERING");
      expect(await orderingStatus(page)).toContain("ordering=ready");
      const log = await eventLog(page);
      expect(log.some((line) => line.includes("MENU_INTENT"))).toBe(true);
      expect(log.some((line) => line.includes("ORDERING_READY"))).toBe(true);
    });

    test("R5: Ordering -> World return", async ({ page }) => {
      await clickWorldPoint(page, MENU_PORTAL);
      await page.waitForTimeout(150);
      await page.click("button[data-return-to-world]");
      await page.waitForTimeout(150);
      const status = await hud(page);
      expect(status).toContain("mode=WORLD_VIEW");
      expect(status).toContain("presentation=WORLD");
      expect(await orderingStatus(page)).toContain("ordering=idle");
    });

    test("R6: reload recovery", async ({ page }) => {
      // Dirty the state first so recovery is meaningfully observable.
      await clickWorldPoint(page, AUL);
      await page.waitForTimeout(150);
      expect(await hud(page)).toContain("interactions=1");

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("canvas", { timeout: 10000 });
      await page.waitForTimeout(300);

      const status = await hud(page);
      expect(status).toContain("mode=WORLD_VIEW");
      expect(status).toContain("aul=idle");
      expect(status).toContain("interactions=0");
      expect(status).toContain("presentation=WORLD");
    });

    test("R7: touch after reload", async ({ page }) => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("canvas", { timeout: 10000 });
      await page.waitForTimeout(300);

      await clickWorldPoint(page, CAT);
      await page.waitForTimeout(150);
      expect(await hud(page)).toContain("mode=CAT_FOCUS");

      // Reset camera to WORLD_VIEW before the next raw-coordinate click —
      // required because a non-1 camera zoom changes where authored
      // world coordinates map on screen (same as every prior gate script).
      await page.click('button[data-camera="WORLD_VIEW"]');
      await page.waitForTimeout(150);

      await clickWorldPoint(page, AUL);
      await page.waitForTimeout(150);
      const aulStatus = await hud(page);
      expect(aulStatus).toContain("mode=AUL_FOCUS");
      expect(aulStatus).toContain("interactions=1");

      await page.click('button[data-camera="WORLD_VIEW"]');
      await page.waitForTimeout(150);

      await clickWorldPoint(page, MENU_PORTAL);
      await page.waitForTimeout(150);
      const portalStatus = await hud(page);
      expect(portalStatus).toContain("mode=MENU_FOCUS");
      expect(await orderingStatus(page)).toContain("ordering=ready");

      await page.click("button[data-return-to-world]");
      await page.waitForTimeout(150);
    });
  });
}
