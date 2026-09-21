// U3 browser e2e - Experience timing at the REAL thresholds (15s / 25s / 5min),
// Habitat entry, and the approved "returnToWorld only when ORDERING" rule.
//
// The fake clock (page.clock) drives performance.now, setTimeout and
// requestAnimationFrame together, so 15s/25s/5min are exact and fast, while
// everything else - Pixi, the AWR bus, the real Kiosk Host, real DOM input - is
// real. Input is real Playwright mouse/keyboard input (trusted events).

import { test, expect } from "@playwright/test";
import { AWR, advance, attribute, boot, counters, domain, events, expectNoProblems, freezeTime, mount, phase, settleFrames, shellAttributes, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

test("E1. the whole chain boots: AWR World -> Composition -> Experience -> Kiosk snapshot (Habitat, Domain READY, TICKs flowing)", async ({ page }) => {
  await mount(page);

  const attrs = await shellAttributes(page);
  expect(attrs["data-interaction-phase"]).toBe("HABITAT_IDLE");
  expect(attrs["data-view"]).toBe("habitat");
  expect(attrs["data-domain-status"]).toBe("READY");
  expect(attrs["data-world-presentation"]).toBe("WORLD");
  expect(attrs["data-world-camera"]).toBe("WORLD_VIEW");

  // One real AWR canvas and one shell inside ONE page (not a separate app).
  const c = await counters(page);
  expect(c.canvases).toBe(1);
  expect(c.roots).toBe(1);
  expect(c.shells).toBe(1);
  expect(await page.locator("[data-aul-canvas] canvas").count()).toBe(1);
  // AWR's dev/test panel is not part of the Composition.
  expect(await page.locator("#awr-status, .awr-dom-panel").count()).toBe(0);

  // The World keeps ticking on its own: frames advance with no customer.
  await freezeTime(page);
  const before = Number(await attribute(page, "data-world-frame"));
  await page.clock.runFor(1_000); // runFor (not a jump) so every animation frame really runs
  const after = Number(await attribute(page, "data-world-frame"));
  expect(after - before).toBeGreaterThan(30);
  expect(await phase(page)).toBe("HABITAT_IDLE");
});

test("E2. 15s / 25s / 5min at the real thresholds: ACTIVE_STANDBY -> SPACE_GIVEN -> RELEASED -> CONTEXT_EXPIRED -> HABITAT_IDLE", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.emptySpace); // 0s: real customer input
  expect(await phase(page)).toBe("ACTIVE_STANDBY");

  await advance(page, 14_900);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await advance(page, 100); // 15.0s
  expect(await phase(page)).toBe("SPACE_GIVEN");

  await advance(page, 9_900);
  expect(await phase(page)).toBe("SPACE_GIVEN");
  await advance(page, 100); // 25.0s
  expect(await phase(page)).toBe("RELEASED");

  await advance(page, 274_900); // 299.9s
  expect(await phase(page)).toBe("RELEASED");
  await advance(page, 100); // 300.0s
  expect(await phase(page)).toBe("HABITAT_IDLE");

  const log = await events(page);
  expect(log.phases).toEqual(["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
  expect(log.errors).toEqual([]);
  // The transient CONTEXT_EXPIRED never rests as the shell's phase.
  expect(await attribute(page, "data-interaction-phase")).toBe("HABITAT_IDLE");
  expect(await attribute(page, "data-view")).toBe("habitat");
});

test("E3. a real input before expiry restarts the whole silence window", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.emptySpace);
  await advance(page, 20_000);
  expect(await phase(page)).toBe("SPACE_GIVEN");

  await tapWorld(page, AWR.emptySpace); // input during SPACE_GIVEN
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await advance(page, 14_900);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await advance(page, 100);
  expect(await phase(page)).toBe("SPACE_GIVEN");

  await advance(page, 270_000); // 285s since the last input: 15s before expiry
  await tapWorld(page, AWR.emptySpace); // input shortly before expiry
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await advance(page, 299_000);
  expect(await phase(page)).not.toBe("HABITAT_IDLE");
});

test("E4. a throttled tab / slept kiosk: one late timer catches up through every crossed phase, in order", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);

  // fastForward jumps the clock and fires each due timer at most once, like a
  // laptop lid closed for ten minutes.
  await page.clock.fastForward(600_000);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).phases).toEqual(["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE"]);
});

test("E5. Habitat entry returns the World only when AWR is in ORDERING (menu portal -> 5min -> WORLD)", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.menuPortal); // real tap: wakes AND activates the portal
  await settleFrames(page);
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS");
  expect(await phase(page)).toBe("ACTIVE_STANDBY");

  // 15s and 25s are Experience-only: AWR is not touched.
  await advance(page, 15_000);
  await advance(page, 10_000);
  expect(await phase(page)).toBe("RELEASED");
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS");

  await advance(page, 274_900);
  await advance(page, 100);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await settleFrames(page);
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
  expect(await attribute(page, "data-world-camera")).toBe("WORLD_VIEW");
});

test("E6. Habitat entry does NOT touch AWR when it is not in ORDERING (Aul focus and mood survive expiry)", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.aul);
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect(await attribute(page, "data-aul-interactions")).toBe("1");

  await advance(page, 299_900);
  await advance(page, 100);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await settleFrames(page);

  // No RETURN_TO_WORLD was emitted: had it been, the camera would be WORLD_VIEW.
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-aul-interactions")).toBe("1");
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

test("E7. the 15s / 25s lifecycle never touches the Domain, and the 5min expiry's ONLY Domain effect is the one guarded release (orders, identity untouched)", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).__u3.domain.addItem());
  await freezeTime(page);
  const before = await domain(page);
  expect(before).toMatchObject({ session: "active", cartLines: 1, orderStatus: "NONE" });

  await tapWorld(page, AWR.emptySpace);
  await advance(page, 15_000);
  await advance(page, 10_000);
  await advance(page, 274_999);
  expect(await phase(page)).toBe("RELEASED"); // 299,999 ms: 1 ms before the expiry
  expect(await domain(page)).toEqual(before); // nothing of 15s / 25s / 299.999s touched the Domain
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);

  await advance(page, 1);
  expect(await phase(page)).toBe("HABITAT_IDLE");

  // U4 S3: the expiry started exactly one release of the (releasable) customer context - nothing else.
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  const c = await counters(page);
  expect(c.portCalls.releaseCustomerContext).toBe(1);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.signOutCalls).toBe(0);
  expect(c.signInCalls).toBe(1); // only the one boot sign-in: no identity rotation
  expect(c.portCalls.beginCustomerSession).toBe(1); // once, at mount - never by a timer
  expect(c.violations).toEqual([]);
  expect((await events(page)).errors).toEqual([]);
});
