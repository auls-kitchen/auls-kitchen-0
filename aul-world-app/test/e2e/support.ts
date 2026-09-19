// Shared e2e helpers. Every spec drives the real page through real input
// (Playwright mouse/keyboard events are trusted, like a customer's), and reads
// results from the shell's data-* attributes and the harness counters.

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export interface Thresholds {
  spaceGivenMs: number;
  releasedMs: number;
  contextExpiredMs: number;
}

// AWR's authored world coordinates (unchanged since AWR-01/03), the same ones
// aul-world-runtime's own e2e uses.
export const AWR = {
  cat: { x: 340, y: 320 },
  aul: { x: 200, y: 310 },
  menuPortal: { x: 460, y: 250 },
  emptySpace: { x: 30, y: 30 }, // no world object here
};

export const CLICK_TARGETS = "[data-aul-canvas] canvas";

export async function boot(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  // Fake timers from document start: setTimeout, requestAnimationFrame and
  // performance.now are all under the test's control.
  await page.clock.install();
  await page.goto("/harness.html");
  await page.waitForFunction(() => (window as any).__u3Ready === true);
  await page.evaluate(() => (window as any).__u3.resetDb());
  return problems;
}

export async function mount(page: Page, thresholds?: Thresholds): Promise<void> {
  await page.evaluate((t) => (window as any).__u3.mount({ thresholds: t }), thresholds);
  await page.evaluate(() => (window as any).__u3.domainSettled());
}

// Stops time. From here only runFor / fastForward move the clock, so every
// threshold below is exact.
//
// Two measured properties of the fake clock shape this helper:
//  1. It keeps running at real speed until paused, so the pause target must
//     still be in the future when the request arrives; too tight a margin fails
//     with "Cannot fast-forward to the past" on a slow round-trip.
//  2. pauseAt jumps forward by that margin, and afterwards the animation-frame
//     chain stalls for up to roughly the size of the jump (measured: a 100ms
//     jump stalled frames for 16ms typically, 128ms worst over 150 pauses; a
//     1000ms jump stalled them for ~1s). Until frames flow, Pixi does not update
//     hit-test transforms, so a tap right after a camera move can miss.
// So: a modest margin, retried wider only if it was too tight, followed by
// priming the frame loop for as long as the jump can stall it. All of this
// happens while the kiosk is idle (no customer, no Experience timer), so it
// cannot disturb any threshold a test measures.
export async function freezeTime(page: Page): Promise<void> {
  let margin = 250;
  for (let attempt = 0; ; attempt++) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + margin);
      break;
    } catch (error) {
      if (!String(error).includes("past") || attempt >= 4) throw error;
      margin *= 2;
    }
  }
  await settleFrames(page, 2, margin * 2 + 500);
}

export async function shellAttributes(page: Page): Promise<Record<string, string>> {
  return page.locator("[data-experience-shell]").evaluate((element) =>
    Object.fromEntries([...element.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value])),
  );
}

export async function attribute(page: Page, name: string): Promise<string> {
  return (await page.locator("[data-experience-shell]").getAttribute(name)) ?? "";
}

export const phase = (page: Page) => attribute(page, "data-interaction-phase");

export const events = (page: Page) =>
  page.evaluate(() => (window as any).__u3.events() as { phases: string[]; wakes: Array<{ route: string; pending: string }>; errors: string[] });

export const counters = (page: Page) => page.evaluate(() => (window as any).__u3.counters());

export const domain = (page: Page) =>
  page.evaluate(() => (window as any).__u3.domain.snapshot() as {
    ready: boolean;
    session: string;
    cartLines: number;
    orderStatus: string;
    canRetryUnknown: boolean;
    canRequestSessionEnd: boolean;
  });

export async function canvasPoint(page: Page, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const canvas = page.locator(CLICK_TARGETS);
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  return { x: box.x + point.x, y: box.y + point.y };
}

// A real, trusted tap on the World canvas.
export async function tapWorld(page: Page, point: { x: number; y: number }): Promise<void> {
  const at = await canvasPoint(page, point);
  await page.mouse.click(at.x, at.y);
}

// Moves the fake clock forward by exactly `ms`. Long gaps jump with
// fastForward (fast) and finish with a short runFor tail, so timers scheduled
// for the END of the span still fire at the exact boundary: advance(page, T)
// crosses a threshold at T, advance(page, T - 1) does not.
// (runFor alone advances roughly 1:1 with wall time while frames are running.)
const TAIL_MS = 100;
export async function advance(page: Page, ms: number): Promise<void> {
  if (ms > TAIL_MS * 2) {
    await page.clock.fastForward(ms - TAIL_MS);
    await page.clock.runFor(TAIL_MS);
  } else {
    await page.clock.runFor(ms);
  }
}

const frameCount = async (page: Page): Promise<number> => Number(await attribute(page, "data-world-frame"));

// Runs the fake clock in 16ms steps until AWR has really produced `minFrames`
// more frames, so the renderer has picked up state changes (camera, etc.). It
// waits for frames, never for a duration: a fixed wait is exactly what flaked.
// It may consume a little fake time (typically 48ms), so it is not used inside
// a window whose threshold a test is measuring to the millisecond.
export async function settleFrames(page: Page, minFrames = 3, budgetMs = 1_000): Promise<void> {
  const start = await frameCount(page);
  for (let waited = 0; waited < budgetMs; waited += 16) {
    await page.clock.runFor(16);
    if ((await frameCount(page)) >= start + minFrames) return;
  }
  throw new Error(`AWR frames did not advance by ${minFrames} within ${budgetMs}ms of fake time`);
}

export async function expectNoProblems(problems: string[]): Promise<void> {
  expect(problems.filter((p) => !p.includes("404")), "unexpected page errors").toEqual([]);
}
