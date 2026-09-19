// U3 browser e2e - lifecycle ownership. The Composition owns everything it
// creates: it must be possible to mount, run, dispose and mount again, at any
// moment (even mid-boot), without leaving a duplicate or leaked timer, listener,
// subscription, animation frame, canvas or callback behind.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AWR, advance, boot, counters, events, expectNoProblems, freezeTime, mount, phase, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

const INPUT_TYPES = ["keydown", "pointerdown", "pointermove", "touchmove", "wheel"];

const dispose = (page: Page) => page.evaluate(() => (window as any).__u3.dispose());

test("M1. mount -> run -> dispose -> mount, three times: no duplicate or leaked timer, listener, subscription, frame, canvas or callback", async ({ page }) => {
  const phaseLogLengths: number[] = [];

  for (let cycle = 1; cycle <= 3; cycle++) {
    await page.clock.resume(); // Pixi's renderer starts up against a running clock
    await mount(page);
    await freezeTime(page);

    // -- freshly mounted: exactly one of everything ---------------------------
    let c = await counters(page);
    expect(c.canvases, `cycle ${cycle}: canvases`).toBe(1);
    expect(c.roots, `cycle ${cycle}: roots`).toBe(1);
    expect(c.shells, `cycle ${cycle}: shells`).toBe(1);
    expect(c.rootListeners.map((l: { type: string }) => l.type).sort(), `cycle ${cycle}: root listeners`).toEqual(INPUT_TYPES);
    expect(c.rootListeners.every((l: { capture: boolean }) => l.capture)).toBe(true);
    expect(c.rootRegistrationsEver, `cycle ${cycle}: this mount registered exactly 5 listeners, ever`).toBe(5);
    expect(c.activeDomainSubscriptions, `cycle ${cycle}: domain subscriptions`).toBe(1);
    expect(c.portCalls.subscribe).toBe(1);
    expect(c.portCalls.beginCustomerSession).toBe(1);
    expect(c.pendingTimers, `cycle ${cycle}: no timer before any customer`).toBe(0);
    expect(c.outstandingFrames, `cycle ${cycle}: the World is ticking`).toBeGreaterThanOrEqual(1);

    // -- run: a customer, and time -------------------------------------------
    await tapWorld(page, AWR.emptySpace);
    expect(await phase(page)).toBe("ACTIVE_STANDBY");
    await advance(page, 20_000);
    expect(await phase(page)).toBe("SPACE_GIVEN");
    c = await counters(page);
    expect(c.pendingTimers, `cycle ${cycle}: exactly one Experience timer while a window is open`).toBe(1);
    expect(c.rootListeners).toHaveLength(5);

    const phasesBefore = (await events(page)).phases.length;

    // -- dispose: nothing survives -------------------------------------------
    await dispose(page);
    c = await counters(page);
    expect(c.canvases, `cycle ${cycle}: canvas removed`).toBe(0);
    expect(c.roots, `cycle ${cycle}: root removed`).toBe(0);
    expect(c.shells, `cycle ${cycle}: shell removed`).toBe(0);
    expect(c.rootListeners, `cycle ${cycle}: every input listener removed`).toEqual([]);
    expect(c.activeDomainSubscriptions, `cycle ${cycle}: Domain subscription released`).toBe(0);
    expect(c.pendingTimers, `cycle ${cycle}: Experience timer cleared`).toBe(0);
    expect(c.outstandingFrames, `cycle ${cycle}: every animation frame cancelled`).toBe(0);

    // -- a disposed Composition is inert: time and touches do nothing ---------
    await advance(page, 600_000);
    await page.mouse.click(400, 300);
    await page.keyboard.press("Enter");
    const after = await counters(page);
    expect(after.pendingTimers).toBe(0);
    expect(after.outstandingFrames).toBe(0);
    expect((await events(page)).phases.length, `cycle ${cycle}: a stale callback fired into a disposed Composition`).toBe(phasesBefore);
    phaseLogLengths.push(phasesBefore);
  }

  expect(phaseLogLengths).toEqual([2, 2, 2]); // ACTIVE_STANDBY, SPACE_GIVEN each cycle - no cross-talk
  expect((await events(page)).errors).toEqual([]);
});

test("M2. dispose() is idempotent and safe in every state", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await dispose(page);
  await dispose(page);
  await dispose(page);
  const c = await counters(page);
  expect(c.canvases + c.roots + c.shells + c.rootListeners.length + c.pendingTimers + c.outstandingFrames + c.activeDomainSubscriptions).toBe(0);
});

test("M3. dispose during Habitat, and during an open silence window, both leave nothing behind", async ({ page }) => {
  // Habitat (no window open)
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await dispose(page);
  let c = await counters(page);
  expect(c.pendingTimers + c.rootListeners.length + c.canvases + c.activeDomainSubscriptions).toBe(0);

  // Open window (RELEASED, timer pending)
  await page.clock.resume();
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await advance(page, 30_000);
  expect(await phase(page)).toBe("RELEASED");
  expect((await counters(page)).pendingTimers).toBe(1);
  await dispose(page);
  c = await counters(page);
  expect(c.pendingTimers + c.rootListeners.length + c.canvases + c.activeDomainSubscriptions).toBe(0);
});

test("M4. dispose while the renderer is still starting: nothing is left, ready resolves, and a fresh mount works", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const api = (window as any).__u3;
    api.mountWithoutWaiting(); // the handle exists immediately; Pixi is still initializing
    api.dispose(); // ... and is disposed before it finishes
    return "disposed";
  });
  expect(outcome).toBe("disposed");
  await page.clock.runFor(200); // let the pending renderer init settle and its chained destroy() run
  await page.waitForTimeout(500);

  const c = await counters(page);
  expect(c.canvases).toBe(0);
  expect(c.roots).toBe(0);
  expect(c.shells).toBe(0);
  expect(c.rootListeners).toEqual([]);
  expect(c.activeDomainSubscriptions).toBe(0);
  expect(c.portCalls.beginCustomerSession).toBe(0); // the Domain was never begun for a Composition that never finished mounting
  expect(c.pendingTimers).toBe(0);
  expect((await events(page)).errors).toEqual([]);

  // A clean mount afterwards.
  await mount(page);
  const fresh = await counters(page);
  expect(fresh.canvases).toBe(1);
  expect(fresh.rootListeners).toHaveLength(5);
});

test("M5. dispose while the Domain is still booting: no late write into a disposed Composition, domainSettled still settles", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__u3.gateAuth();
    return (window as any).__u3.mount();
  });
  const settled = await page.evaluate(async () => {
    const api = (window as any).__u3;
    const domainSettled = api.domainSettled(); // pending: the Domain is gated
    api.dispose();
    api.releaseAuth(); // the Domain finishes booting after the Composition is gone
    await domainSettled;
    return "settled";
  });
  expect(settled).toBe("settled");

  const c = await counters(page);
  expect(c.roots + c.shells + c.canvases + c.rootListeners.length + c.activeDomainSubscriptions + c.pendingTimers).toBe(0);
  expect((await events(page)).errors).toEqual([]);
});
