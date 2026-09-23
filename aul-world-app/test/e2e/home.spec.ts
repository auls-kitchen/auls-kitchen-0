// U4 Slice 2A/S4c browser e2e - the X/Home decision boundary AND (S4c) what an
// accepted decision now does, in a real page: real AWR World, real Composition,
// real Kiosk Host/Runtime (fake Firebase, real IndexedDB), and REAL trusted
// input (Playwright mouse/keyboard events).
//
// Pressing Home always reads one Domain snapshot and applies the pure takeover
// policy first (unchanged since 2A). What happens next depends only on the
// decision:
//   NO_TAKEOVER / NOT_READY   a pure no-op - no release, no presentation change
//   BLOCKED_UNKNOWN           a "protected" presentation ONLY - no release, no
//                             clear, no reset, no new epoch (locked)
//   TAKEOVER_ACTIVE_CART/
//   TAKEOVER_CONFIRMATION     reconciled for real through the SAME shared
//                             machinery a wake already uses (S4c): a genuine
//                             release, a gated World reset, and a final
//                             "discover"/"unavailable" presentation
// The Composition sees the Domain only through a proxied port that records
// every access and throws on any capability outside the five it may use, so
// `violations: []` still proves nothing beyond the one guarded release seam
// was ever touched.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AWR, advance, attribute, boot, counters, domain, events, expectNoProblems, freezeTime, mount, phase, settleFrames, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

const u3 = <T,>(page: Page, run: (api: any) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__u3)`) as Promise<T>;

const HOME = "[data-shell-action=home]";
const pressHome = (page: Page) => page.locator(HOME).click({ force: true }); // a real, trusted pointerdown + click
const decisions = async (page: Page) => (await events(page)).homeDecisions;

// A customer arrives (a real touch wakes the kiosk, Domain empty), then the
// Domain is put into some state by that customer's actions.
async function arrive(page: Page, customerActions?: () => Promise<void>): Promise<void> {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await customerActions?.();
}

const withCart = (page: Page) => () => u3(page, (api) => api.domain.addItem());
const withConfirmation = (page: Page) => () =>
  u3(page, async (api) => {
    api.domain.addItem();
    await api.domain.submit(); // default back end mode: success
  });
const withUnknown = (page: Page) => () =>
  u3(page, async (api) => {
    api.setMode("unknown");
    api.domain.addItem();
    await api.domain.submit();
  });

// Nothing about a Home activation touched the Domain: only the allowed Composition
// calls exist, never the release, no identity change, and no extra order call.
async function expectNoDomainEffect(page: Page, orderIntentCalls: number, snapshotReads: number): Promise<void> {
  const c = await counters(page);
  expect(c.violations).toEqual([]);
  expect(c.portCalls.releaseCustomerContext).toBe(0);
  expect(c.signInCalls).toBe(1);
  expect(c.signOutCalls).toBe(0);
  expect(c.orderIntentCalls).toBe(orderIntentCalls);
  expect(c.portCalls.beginCustomerSession).toBe(1);
  expect(c.portCalls.getSnapshot).toBe(snapshotReads);
}

// Home never routes: the view the customer's wake chose is still there, and the
// old ownership question is nowhere. (Only true for NO_TAKEOVER/NOT_READY: S4c
// gives BLOCKED_UNKNOWN and an accepted takeover their own real presentation.)
async function expectNoRouting(page: Page): Promise<void> {
  expect(await attribute(page, "data-view")).toBe("discover");
  expect(await attribute(page, "data-wake-route")).toBe("DISCOVER_MENU");
  expect(await page.locator("[data-experience-shell]").getAttribute("data-pending")).toBeNull(); // U4 S4a: the hook is gone
  const text = (await page.locator("[data-experience-shell]").innerText()).toLowerCase();
  for (const word of ["bukan", "ini pesanan", "ownership"]) expect(text).not.toContain(word);
}

// S4c: an ACCEPTED takeover that released for real - the shell shows a fresh Discover,
// same as a wake's own FRESH reconciliation would.
async function expectRoutedToDiscover(page: Page): Promise<void> {
  expect(await attribute(page, "data-view")).toBe("discover");
  expect(await attribute(page, "data-wake-route")).toBe("DISCOVER_MENU");
}

// S4c: BLOCKED_UNKNOWN presents the neutral protected view - never an ownership question,
// never a release.
async function expectProtectedPresentation(page: Page): Promise<void> {
  expect(await attribute(page, "data-view")).toBe("protected");
  expect(await attribute(page, "data-wake-route")).toBe("PROTECTED_NEUTRAL");
}

// ============================================================
// Before the release boundary: NO_TAKEOVER, Domain and Cart untouched
// ============================================================

test("X1. ACTIVE + Cart at 10s and at 20s: NO_TAKEOVER, and the Cart is untouched", async ({ page }) => {
  await arrive(page, withCart(page));

  await advance(page, 10_000);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await pressHome(page);
  expect(await decisions(page)).toEqual(["NO_TAKEOVER"]);

  await advance(page, 20_000);
  expect(await phase(page)).toBe("SPACE_GIVEN");
  await pressHome(page);
  expect(await decisions(page)).toEqual(["NO_TAKEOVER", "NO_TAKEOVER"]);

  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1, orderStatus: "NONE" });
  expect(await phase(page)).toBe("ACTIVE_STANDBY"); // a press is customer input
  await expectNoRouting(page);
  await expectNoDomainEffect(page, 0, 1 + 2); // one wake + two Home activations
});

// ============================================================
// At/after RELEASED
// ============================================================

test("X2. ACTIVE + Cart at 26s: TAKEOVER_ACTIVE_CART is DECIDED and RECONCILED - a real release, a gated World reset, and a fresh Discover", async ({ page }) => {
  await arrive(page, withCart(page));

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  // ACTIVE releases synchronously in the real Domain (no IndexedDB round-trip), so the
  // release, the reset, and the final presentation are all already settled here.
  expect(await domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await expectRoutedToDiscover(page);
  const c = await counters(page);
  expect(c.violations).toEqual([]);
  expect(c.portCalls.releaseCustomerContext).toBe(1);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.signOutCalls).toBe(0); // released, never ended: no identity rotation
});

test("X3. CONFIRMATION: NO_TAKEOVER before 25s, TAKEOVER_CONFIRMATION at 26s - reconciled for real, the persisted result removed, and the return sees Discover", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  expect(await domain(page)).toMatchObject({ session: "confirmation", cartLines: 1, orderStatus: "CONFIRMED" });

  await advance(page, 10_000);
  await pressHome(page);
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NO_TAKEOVER", "TAKEOVER_CONFIRMATION"]);
  // A CONFIRMATION release awaits IndexedDB, so the final presentation settles a moment later.
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await expect.poll(() => attribute(page, "data-view")).toBe("discover");
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ hasAuthoritativeResult: false });
  await expectRoutedToDiscover(page);
  const c = await counters(page);
  expect(c.portCalls.releaseCustomerContext).toBe(1);
  expect(c.orderIntentCalls).toBe(1); // the one original submit: the release never touches the back end
});

test("X4. UNKNOWN is BLOCKED_UNKNOWN at 10s and at 26s: a protected presentation ONLY - nothing cleared, reset, retried, rotated, or discarded, and no new epoch begins", async ({ page }) => {
  await arrive(page, withUnknown(page));
  const before = await domain(page);
  expect(before).toMatchObject({ session: "awaiting_outcome", cartLines: 1, orderStatus: "UNCERTAIN" });

  await advance(page, 10_000);
  await pressHome(page);
  await expectProtectedPresentation(page);
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  const readsBeforeSecondPress = (await counters(page)).portCalls.getSnapshot;
  await pressHome(page);

  expect(await decisions(page)).toEqual(["BLOCKED_UNKNOWN", "BLOCKED_UNKNOWN"]);
  expect(await domain(page)).toEqual(before); // the very same Domain, including canRetryUnknown and canRequestSessionEnd
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", submissionStatus: "UNKNOWN" });
  await expectProtectedPresentation(page);
  const c = await counters(page);
  expect(c.portCalls.releaseCustomerContext).toBe(0);
  expect(c.orderIntentCalls).toBe(1); // the one original submit: never a retry
  // BLOCKED_UNKNOWN's presentation is a direct call, never through reconcileContext: exactly
  // one snapshot read for this second press, no epoch-related extra read.
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBeforeSecondPress + 1);
});

test("X5. ACTIVE + EMPTY Cart at 26s: NO_TAKEOVER (no ticket-based ownership boundary)", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => {
    api.domain.addItem();
    api.domain.clearCart(); // leaves the session active with no lines
  }));
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 0 });

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NO_TAKEOVER"]);
  await expectNoDomainEffect(page, 0, 2);
});

test("X6. a Domain that is not ready is NOT_READY at 26s (fail closed): a pure no-op, S4c does not invent a waiting presentation for it", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  const viewBefore = await attribute(page, "data-view");
  const routeBefore = await attribute(page, "data-wake-route");

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NOT_READY"]);
  // NOT_READY stays a no-op (locked): the presentation is exactly whatever it already was.
  expect(await attribute(page, "data-view")).toBe(viewBefore);
  expect(await attribute(page, "data-wake-route")).toBe(routeBefore);
  const c = await counters(page);
  expect(c.violations).toEqual([]);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.portCalls.releaseCustomerContext).toBe(0);
});

// ============================================================
// Phase-before-input, in the browser
// ============================================================

test("X7. OVERDUE TIMER: 30s of real silence, the 25s callback has NOT fired - Home still finds RELEASED", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  // From here on the Experience's timeouts are accepted but never run: a throttled tab.
  await u3(page, (api) => api.holdTimers(true));
  await tapWorld(page, AWR.emptySpace);
  await u3(page, (api) => api.domain.addItem());

  await advance(page, 30_000);
  expect(await phase(page)).toBe("ACTIVE_STANDBY"); // the timer really is behind
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  // The missed phases are still reported, in order, BEFORE the input.
  expect((await events(page)).phases).toEqual(["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "ACTIVE_STANDBY"]);
  // S4c: the accepted takeover reconciled for real (ACTIVE releases synchronously).
  expect(await domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  await u3(page, (api) => api.releaseHeldTimers());
});

test("X8. OVERDUE TIMER past 5 minutes: the expiry is delivered before the wake, and a press from Habitat is NO_TAKEOVER", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await u3(page, (api) => api.holdTimers(true));
  await tapWorld(page, AWR.emptySpace);

  await advance(page, 360_000);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NO_TAKEOVER"]); // phaseBefore was HABITAT_IDLE
  expect((await events(page)).phases).toEqual(["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE", "ACTIVE_STANDBY"]);
  await u3(page, (api) => api.releaseHeldTimers());
});

test("X9. a press that wakes the kiosk from Habitat: NO_TAKEOVER, and the wake path (not Home) routes", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await pressHome(page); // the first touch of the day happens to land on Home

  expect(await decisions(page)).toEqual(["NO_TAKEOVER"]);
  expect((await events(page)).wakes).toEqual([{ route: "DISCOVER_MENU", pending: "NONE" }]);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await expectNoRouting(page);
});

test("X10. a real drag and a real wheel between the press and the release never overwrite the latched phase", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");

  const home = page.locator(HOME);
  await home.scrollIntoViewIfNeeded();
  const box = (await home.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down(); // the PRESS: latches RELEASED, then resets the window
  await page.mouse.move(x + 1, y + 1); // a drag (pressed pointer moving)
  await page.mouse.wheel(0, 40); // a wheel
  await page.mouse.up(); // released on the same element: a click

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
});

test("X11. a second press overwrites the first and fails safe: a tap at 26s and then Home is NO_TAKEOVER", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");

  await tapWorld(page, AWR.emptySpace); // a press at RELEASED: it latches RELEASED and resets the window
  await pressHome(page); // this press finds ACTIVE_STANDBY and must not inherit the older RELEASED

  expect(await decisions(page)).toEqual(["NO_TAKEOVER"]);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
});

// ============================================================
// Untrusted / script activation fails closed
// ============================================================

test("X12. a script .click() and a dispatched click do nothing - no decision, no Domain read, and the window is not reset", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  const readsBefore = (await counters(page)).portCalls.getSnapshot;

  await page.evaluate(() => (document.querySelector("[data-shell-action=home]") as HTMLElement).click());
  await page.evaluate(() => document.querySelector("[data-shell-action=home]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(await decisions(page)).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBefore);
  expect(await phase(page)).toBe("RELEASED"); // script activity is not customer input

  // ...and the customer who then really presses Home still finds RELEASED: the
  // script neither consumed nor disturbed anything.
  await pressHome(page);
  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
});

test("X13. a script .click() right after a REAL press elsewhere still does nothing, even though a real press is latched", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);

  await tapWorld(page, AWR.emptySpace); // a real press: RELEASED is latched
  await page.evaluate(() => (document.querySelector("[data-shell-action=home]") as HTMLElement).click());

  expect(await decisions(page)).toEqual([]);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
});

test("X14. the latch is one-shot end to end: one real activation yields one decision, and a later script click adds none", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);

  await pressHome(page);
  await page.evaluate(() => (document.querySelector("[data-shell-action=home]") as HTMLElement).click());

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
});

// ============================================================
// Keyboard
// ============================================================

test("X15. keyboard: focus alone is not a press; Enter and then Space on the focused Home button decide like a click", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");

  await page.locator(HOME).focus();
  expect(await decisions(page)).toEqual([]);
  expect(await phase(page)).toBe("RELEASED"); // focus is not customer input

  await page.keyboard.press("Enter");
  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  // U4 S4c: the Enter press just released the cart for real - a new one is needed for the
  // second press to find anything to take over (addItem is a direct API call, not customer
  // input, so it does not disturb the silence window already counting from the Enter press).
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await u3(page, (api) => api.domain.addItem());

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await page.keyboard.press(" ");
  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART", "TAKEOVER_ACTIVE_CART"]);
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(2);
});

// ============================================================
// The shell and the Composition boundary
// ============================================================

test("X16. Home exposes no business state: its shell hooks carry no decision, ticket, cart, or order data - before AND after the takeover it accepts settles", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  await advance(page, 26_000);
  await pressHome(page);
  expect(await decisions(page)).toEqual(["TAKEOVER_CONFIRMATION"]);

  const readAttributes = () =>
    page.locator("[data-experience-shell]").evaluate((element) => Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])));

  const checkNoBusinessState = (attributes: Record<string, string>) => {
    const names = Object.keys(attributes);
    expect(names.filter((name) => /home|decision|takeover|ticket|cart|order|confirm/i.test(name))).toEqual([]);
    for (const value of Object.values(attributes)) {
      expect(/TAKEOVER|BLOCKED|NO_TAKEOVER|CONFIRMATION|ACTIVE_CART/.test(value)).toBe(false);
    }
  };

  checkNoBusinessState(await readAttributes()); // immediately: still mid-reconciliation
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle" }); // wait for the real release to settle
  checkNoBusinessState(await readAttributes()); // and again: the final "discover" presentation carries none either
});

test("X17. the shell has exactly two buttons, pressing either changes nothing in the Domain and releases nothing - only the 5-minute expiry releases", async ({ page }) => {
  await arrive(page, withCart(page));
  const before = await domain(page);
  const buttons = page.locator("[data-experience-shell] button");
  expect(await buttons.evaluateAll((elements) => elements.map((e) => e.getAttribute("data-shell-action")))).toEqual(["menu", "home"]);

  // Before the expiry: neither button touches the Domain, and neither releases.
  await page.locator("[data-shell-action=menu]").click({ force: true });
  await pressHome(page);
  expect(await domain(page)).toEqual(before);
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(0);

  // Across the 5-minute expiry (U4 S3): the Domain here is releasable (ACTIVE + Cart), so the
  // expiry - and only the expiry - starts exactly one release. That is the S3 effect; the old
  // "the Domain is untouched after 5 minutes" no longer holds, by design.
  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await tapWorld(page, AWR.emptySpace);

  const c = await counters(page);
  expect(c.portCalls.releaseCustomerContext).toBe(1); // one, from the expiry: the return added none
  expect(c.violations).toEqual([]);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.signOutCalls).toBe(0);
});

// ============================================================
// U4 S4c: the takeover executor - FRESH resets the World, UNAVAILABLE never does,
// and a Home takeover never consumes another release's verdict
// ============================================================

test("X18. TAKEOVER_ACTIVE_CART + FRESH: the World reset actually happens - RESET_WORLD then RETURN_TO_WORLD (Aul's focus and mood return to idle/WORLD_VIEW)", async ({ page }) => {
  await arrive(page, withCart(page));
  await tapWorld(page, AWR.aul); // BEFORE the takeover: mood happy, camera AUL_FOCUS - nothing touches it after this
  await settleFrames(page);
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
  expect(await attribute(page, "data-world-camera")).toBe("WORLD_VIEW");
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
  await expectRoutedToDiscover(page);
});

test("X19. TAKEOVER_CONFIRMATION + FRESH: the same reset happens once the (async, real) release settles", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  await tapWorld(page, AWR.aul);
  await settleFrames(page);
  await advance(page, 26_000);
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_CONFIRMATION"]);
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
  expect(await attribute(page, "data-world-camera")).toBe("WORLD_VIEW");
  await expectRoutedToDiscover(page);
});

test("X20. TAKEOVER + UNAVAILABLE (refused): the release still ran once, but NO World reset, and the presentation is the neutral unavailable view", async ({ page }) => {
  await arrive(page, withCart(page));
  await tapWorld(page, AWR.aul);
  await settleFrames(page);
  await page.evaluate(() => (window as any).__u3.setReleaseMode("refuse"));
  await advance(page, 26_000);
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // refused: untouched
  expect(await attribute(page, "data-aul-mood")).toBe("happy"); // no reset
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  expect(await attribute(page, "data-view")).toBe("unavailable");
  expect(await attribute(page, "data-wake-route")).toBe("UNAVAILABLE_NEUTRAL");
});

test("X21. TAKEOVER + a release that throws/rejects: no reset, UNAVAILABLE_NEUTRAL, and the error is reported once - never a retry", async ({ page }) => {
  await arrive(page, withCart(page));
  await page.evaluate(() => (window as any).__u3.setReleaseMode("reject"));
  await advance(page, 26_000);
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
  expect(await attribute(page, "data-view")).toBe("unavailable");
  expect(await attribute(page, "data-wake-route")).toBe("UNAVAILABLE_NEUTRAL");
  const errors = (await events(page)).errors;
  expect(errors.filter((e) => /test release/.test(e))).toHaveLength(1);
});

test("X22. HOME's takeover while an earlier release is STILL SETTLING: it never consumes that verdict - it waits, then decides entirely from its OWN fresh read", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem())); // customer A
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));
  await advance(page, 300_000); // A's own expiry starts a HELD release
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1);

  await tapWorld(page, AWR.emptySpace); // customer B arrives: the wake finds the SAME still-held cart, also contested
  await advance(page, 26_000); // B is silent long enough to reach RELEASED themselves
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page); // B's OWN takeover attempt - ALSO contested: the SAME release is still held

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]); // B sees the same leftover cart: same decision
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // A's release hasn't run yet
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1); // Home did NOT start a second release
  const readsBeforeSettle = (await counters(page)).portCalls.getSnapshot;

  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1); // A's held release finally runs (real, FRESH)

  // Neither A's stale expiry continuation nor B's now-superseded WAKE continuation may present or
  // reset anything - only B's LATEST (Home's) continuation, deciding from its OWN fresh read.
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await expectRoutedToDiscover(page);
  expect((await counters(page)).portCalls.releaseCustomerContext).toBe(1); // still just the one, real release
  // Exactly ONE more read (B's Home's own fresh read) - B's now-superseded WAKE continuation
  // must never read again: an isCurrent guard, not merely "the coordinator became free".
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBeforeSettle + 1);
  expect((await events(page)).errors).toEqual([]);
});
