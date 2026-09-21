// U4 Slice 2A browser e2e - the X/Home decision boundary, in a real page: real
// AWR World, real Composition, real Kiosk Host/Runtime (fake Firebase, real
// IndexedDB), and REAL trusted input (Playwright mouse/keyboard events).
//
// Slice 2A proves the DECISION only. Pressing Home reads one Domain snapshot,
// applies the pure takeover policy, and records the decision. It releases
// nothing, clears nothing, routes nothing - so every test also asserts the
// Domain is exactly as the previous customer left it. The Composition sees the
// Domain only through a proxied port that records every access and throws on
// any capability outside the five it may use, and counts the guarded release
// (`releaseCustomerContext`, used by the 5-minute expiry only - see expiry.spec.ts),
// so the zero release count and `violations: []` prove a Home activation made no
// release call (or any other Domain call) at all.

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
// old ownership question is nowhere.
async function expectNoRouting(page: Page): Promise<void> {
  expect(await attribute(page, "data-view")).toBe("discover");
  expect(await attribute(page, "data-wake-route")).toBe("DISCOVER_MENU");
  expect(await page.locator("[data-experience-shell]").getAttribute("data-pending")).toBeNull(); // U4 S4a: the hook is gone
  const text = (await page.locator("[data-experience-shell]").innerText()).toLowerCase();
  for (const word of ["bukan", "ini pesanan", "ownership"]) expect(text).not.toContain(word);
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

test("X2. ACTIVE + Cart at 26s: TAKEOVER_ACTIVE_CART is DECIDED - and nothing is released", async ({ page }) => {
  await arrive(page, withCart(page));

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART"]);
  // Slice 2A decides only: the previous customer's Cart is still exactly there.
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1, orderStatus: "NONE" });
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  await expectNoRouting(page);
  await expectNoDomainEffect(page, 0, 2);
});

test("X3. CONFIRMATION: NO_TAKEOVER before 25s, TAKEOVER_CONFIRMATION at 26s - and the confirmation and its persisted result are untouched", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  expect(await domain(page)).toMatchObject({ session: "confirmation", cartLines: 1, orderStatus: "CONFIRMED" });

  await advance(page, 10_000);
  await pressHome(page);
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NO_TAKEOVER", "TAKEOVER_CONFIRMATION"]);
  expect(await domain(page)).toMatchObject({ session: "confirmation", cartLines: 1, orderStatus: "CONFIRMED" });
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", hasAuthoritativeResult: true });
  await expectNoRouting(page);
  await expectNoDomainEffect(page, 1, 1 + 2);
});

test("X4. UNKNOWN is BLOCKED_UNKNOWN at 10s and at 26s: nothing cleared, reset, retried, rotated, or discarded", async ({ page }) => {
  await arrive(page, withUnknown(page));
  const before = await domain(page);
  expect(before).toMatchObject({ session: "awaiting_outcome", cartLines: 1, orderStatus: "UNCERTAIN" });

  await advance(page, 10_000);
  await pressHome(page);
  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["BLOCKED_UNKNOWN", "BLOCKED_UNKNOWN"]);
  expect(await domain(page)).toEqual(before); // the very same Domain, including canRetryUnknown and canRequestSessionEnd
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", submissionStatus: "UNKNOWN" });
  await expectNoRouting(page);
  await expectNoDomainEffect(page, 1, 1 + 2); // the one original submit: never a retry
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

test("X6. a Domain that is not ready is NOT_READY at 26s (fail closed), and the World and shell stay alive", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await pressHome(page);

  expect(await decisions(page)).toEqual(["NOT_READY"]);
  const c = await counters(page);
  expect(c.violations).toEqual([]);
  expect(c.orderIntentCalls).toBe(0);
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
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
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

  await advance(page, 26_000);
  expect(await phase(page)).toBe("RELEASED");
  await page.keyboard.press(" ");
  expect(await decisions(page)).toEqual(["TAKEOVER_ACTIVE_CART", "TAKEOVER_ACTIVE_CART"]);
});

// ============================================================
// The shell and the Composition boundary
// ============================================================

test("X16. Home exposes no business state: its shell hooks carry no decision, ticket, cart, or order data", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  await advance(page, 26_000);
  await pressHome(page);
  expect(await decisions(page)).toEqual(["TAKEOVER_CONFIRMATION"]);

  const attributes = await page.locator("[data-experience-shell]").evaluate((element) =>
    Object.fromEntries([...element.attributes].map((a) => [a.name, a.value])),
  );
  const names = Object.keys(attributes);
  expect(names.filter((name) => /home|decision|takeover|ticket|cart|order|confirm/i.test(name))).toEqual([]);
  for (const value of Object.values(attributes)) {
    expect(/TAKEOVER|BLOCKED|NO_TAKEOVER|CONFIRMATION|ACTIVE_CART/.test(value)).toBe(false);
  }
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
