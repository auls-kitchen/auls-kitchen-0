// U4 Slice 2B, D2 Step 2 browser e2e - the Menu/Product first-press takeover gate, in a
// real page: real AWR World, real Composition, real Kiosk Host/Runtime (fake Firebase,
// real IndexedDB), and REAL trusted input (Playwright mouse/keyboard events).
//
// The shell Menu button and the canvas Menu Portal - ONLY - share ONE gate
// (handleMenuInteraction in compositionRoot.ts) before the original, unmodified
// MENU_INTENT action reaches AWR:
//   no fresh gesture / NO_TAKEOVER   the original action proceeds immediately, unchanged
//   BLOCKED_UNKNOWN / NOT_READY      the existing customer-return presentation only -
//                                    the original action never proceeds
//   TAKEOVER_ACTIVE_CART/CONFIRMATION  reconciled for real through the SAME shared
//                                    machinery Home's takeover already uses; the
//                                    original action runs exactly once, only after a
//                                    FRESH settlement (D2 Step 1's onFresh continuation)
//
// Character/Reactive/Decorative/Event are explicitly OUT of D2 (Owner-corrected scope):
// no prior Owner-locked record ever named Character/Reactive as takeover triggers, and
// decideTakeover's any-phase BLOCKED_UNKNOWN/NOT_READY semantics would otherwise suppress
// ordinary world interaction that world.spec.ts (P1/P2), boundary.spec.ts (BD2/BD3),
// domain.spec.ts (R6) and input.spec.ts (W1) already establish as unconditional. MT7/MT8
// below exist specifically to protect that restored contract from this file's own vantage
// point, alongside BD3/R6/W1 themselves.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AWR, advance, attribute, boot, counters, domain, events, expectNoProblems, freezeTime, mount, phase, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

const u3 = <T,>(page: Page, run: (api: any) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__u3)`) as Promise<T>;

const MENU = "[data-shell-action=menu]";
const pressMenu = (page: Page) => page.locator(MENU).click({ force: true }); // a real, trusted pointerdown + click
const wakes = async (page: Page) => (await events(page)).wakes;

// A customer arrives (a real touch wakes the kiosk, Domain empty), then the Domain is
// put into some state by that customer's actions. Mirrors home.spec.ts's own `arrive`.
async function arrive(page: Page, customerActions?: () => Promise<void>): Promise<void> {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await customerActions?.();
}

const withCart = (page: Page) => () => u3(page, (api) => api.domain.addItem());
const withUnknown = (page: Page) => () =>
  u3(page, async (api) => {
    api.setMode("unknown");
    api.domain.addItem();
    await api.domain.submit();
  });

// AWR's authored world coordinates not already in support.ts's AWR export, reused as
// plain points (support.ts stays untouched: these three are used only here).
const REACTIVE_STALL = { x: 260, y: 260 }; // mid-stall (Reactive)
const DECORATIVE_HILL = { x: 120, y: 140 }; // bg-hill-1 (Decorative)

// ============================================================
// 1-2. RELEASED + eligible active cart -> reconciliation (shell Menu button)
// ============================================================

test("MT1. shell Menu at RELEASED + an eligible active cart: a real release, and MENU_INTENT is forwarded exactly once, only AFTER the FRESH settlement", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");

  await pressMenu(page);

  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  // Forwarded exactly once, after settlement: AWR's own ordering boundary took over.
  await expect.poll(() => attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-view")).toBe("discover");
});

// ============================================================
// 3-4. FRESH forwards exactly once; UNAVAILABLE suppresses it
// ============================================================

test("MT2. shell Menu + UNAVAILABLE (refused): the release still ran once, but MENU_INTENT is never forwarded, and the presentation is the neutral unavailable view", async ({ page }) => {
  await arrive(page, withCart(page));
  await page.evaluate(() => (window as any).__u3.setReleaseMode("refuse"));
  await advance(page, 26_000);
  await pressMenu(page);

  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // refused: untouched
  expect(await attribute(page, "data-view")).toBe("unavailable");
  expect(await attribute(page, "data-wake-route")).toBe("UNAVAILABLE_NEUTRAL");
  // The original Menu action never proceeded as though the takeover had succeeded.
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

// ============================================================
// 5. UNKNOWN stays protected; the original action is suppressed
// ============================================================

test("MT3. shell Menu while UNKNOWN: protected presentation only - zero release calls, and MENU_INTENT is never forwarded", async ({ page }) => {
  await arrive(page, withUnknown(page));
  await advance(page, 26_000);
  const before = (await wakes(page)).length;

  await pressMenu(page);

  expect(await attribute(page, "data-view")).toBe("protected");
  expect(await attribute(page, "data-wake-route")).toBe("PROTECTED_NEUTRAL");
  expect((await wakes(page)).length).toBe(before + 1);
  expect((await wakes(page)).at(-1)).toEqual({ route: "PROTECTED_NEUTRAL", pending: "UNRESOLVED" });
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

// ============================================================
// 6. NOT_READY: the locked D2 contract for Menu (unlike Home's no-op) actively
//    presents the existing waiting view, and suppresses the original action
// ============================================================

test("MT4. shell Menu while the Domain is not ready: the existing WAIT_NOT_READY/waiting presentation is actively re-entered, and MENU_INTENT is never forwarded", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  const before = (await wakes(page)).length;

  await pressMenu(page);

  // Menu's own NOT_READY branch genuinely ran presentImmediate (not merely "already was
  // waiting" from the earlier wake) - proven by a NEW wakes() entry, not just the view.
  expect((await wakes(page)).length).toBe(before + 1);
  expect((await wakes(page)).at(-1)).toEqual({ route: "WAIT_NOT_READY", pending: "NOT_READY" });
  expect(await attribute(page, "data-view")).toBe("waiting");
  const c = await counters(page);
  expect(c.portCalls.releaseCustomerContext).toBe(0);
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

// ============================================================
// 7. NO_TAKEOVER: the original action proceeds normally, unchanged
// ============================================================

test("MT5. shell Menu at a phase that is not RELEASED: NO_TAKEOVER - MENU_INTENT proceeds immediately, zero release calls", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 15_000);
  expect(await phase(page)).toBe("SPACE_GIVEN");
  const before = (await wakes(page)).length;

  await pressMenu(page);

  // NO_TAKEOVER never calls presentImmediate: no new wakes() entry, and no delay.
  expect((await wakes(page)).length).toBe(before);
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // untouched
});

// ============================================================
// 8. Portal follows the exact same takeover semantics as the shell Menu button
// ============================================================

test("MT6. canvas Menu Portal at RELEASED + an eligible active cart: the same reconciliation, and handleObjectHit's own MENU_INTENT is forwarded exactly once, only after FRESH", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);

  await tapWorld(page, AWR.menuPortal);

  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  await expect.poll(() => attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS"); // AWR's own reaction to MENU_INTENT
});

// ============================================================
// 8b. Character/Reactive are OUT of D2 (Owner-corrected scope): ordinary world
//     interaction stays unconditional, exactly as BD2/BD3/R6/W1/P1/P2 establish -
//     even at RELEASED, with an eligible active cart that WOULD trigger a takeover
//     for Menu/Portal, and even while UNKNOWN or the Domain is not ready.
// ============================================================

test("MT7. a Character press (Aul) at RELEASED + an eligible active cart is NOT gated by D2: it activates immediately, exactly as before this slice, and starts no release", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  const readsBefore = (await counters(page)).portCalls.getSnapshot;

  await tapWorld(page, AWR.aul);

  // Immediate, unconditional: no reconciliation, no extra Domain read, no release.
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect(await attribute(page, "data-aul-interactions")).toBe("1");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBefore); // no D2 snapshot read for Character
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // untouched
});

test("MT8. a Reactive press (mid-stall) at RELEASED + an eligible active cart is NOT gated by D2 either: zero release calls, zero extra snapshot reads", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  const readsBefore = (await counters(page)).portCalls.getSnapshot;

  await tapWorld(page, REACTIVE_STALL);

  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBefore);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
});

test("MT8b. a Character press (Aul) while UNKNOWN is NOT suppressed by D2 (protects BD3): Aul still reacts, and zero release calls are made", async ({ page }) => {
  await arrive(page, withUnknown(page));

  await tapWorld(page, AWR.aul);

  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome", orderStatus: "UNCERTAIN" });
});

test("MT8c. a Character press (Aul) while the Domain is not ready is NOT suppressed by D2 (protects R6/W1): Aul still reacts on the very first, waking press", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.aul);

  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect((await counters(page)).portCalls.getSnapshot).toBe(1); // exactly one read - the wake's own, no D2 read added
  expect((await events(page)).wakes).toEqual([{ route: "WAIT_NOT_READY", pending: "NOT_READY" }]);
});

// ============================================================
// 9. Decorative/Event objects are OUT OF SCOPE: never gated, never take over
// ============================================================

test("MT9. a Decorative press (bg-hill-1) at RELEASED + an eligible active cart: OUT OF SCOPE - handleObjectHit runs immediately, zero release calls", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");

  await tapWorld(page, DECORATIVE_HILL);

  // Never gated: no release was ever started, the cart is exactly as the customer left it,
  // and (Decorative's intent is NONE) nothing about the World's presentation changed either.
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
});

// ============================================================
// 10. Stale/contested ownership can never forward the deferred action
// ============================================================

test("MT10. Menu's takeover while an earlier release is STILL SETTLING: it never consumes that verdict, decides entirely from its OWN fresh read, and never forwards MENU_INTENT for a context already gone", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem())); // customer A
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));
  await advance(page, 300_000); // A's own expiry starts a HELD release
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);

  await tapWorld(page, AWR.emptySpace); // customer B arrives: the wake finds the SAME still-held cart, also contested
  await advance(page, 26_000); // B is silent long enough to reach RELEASED themselves
  expect(await phase(page)).toBe("RELEASED");
  await pressMenu(page); // B's OWN Menu takeover attempt - ALSO contested: the SAME release is still held

  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // A's release hasn't run yet
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1); // Menu did NOT start a second release

  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1); // A's held release finally runs (real, FRESH)

  // B's own fresh read (after A's release) finds an idle Domain: nothing left to release, so
  // B's Menu attempt presents a plain Discover and NEVER forwards MENU_INTENT for it - the
  // stale expiry continuation's FRESH verdict is not B's, and B's own re-check found nothing.
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect(await attribute(page, "data-view")).toBe("discover");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1); // still just the one, real release
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD"); // Menu never proceeded
});

// ============================================================
// 11. Regression: an ordinary Menu press with no prior gesture, or a script click,
//     behave exactly as before this slice
// ============================================================

test("MT11. a script .click() on the Menu button does nothing new: no gesture, so the gate is never even reached differently than today", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);

  await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).click(), MENU);
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING"); // untrusted click still activates the button (unchanged)
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0); // ...but never a takeover: no trusted press preceded it
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
});
