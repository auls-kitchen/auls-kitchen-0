// U3 browser e2e - the Kiosk Domain seam, against the REAL Kiosk Host/Runtime/
// Experience projection (built from kiosk/ source, fake Firebase + real
// IndexedDB): pending-ticket routing on return from Habitat, UNKNOWN staying
// protected, Domain events settling while nobody is at the kiosk, and the
// Domain's boot failure paths. The Composition only ever sees a proxied port
// that records every access and throws on any capability outside the four it
// is allowed.

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

// A customer arrives (real touch), the Domain is put into some state by the
// customer's actions, the kiosk goes silent for the full 5 minutes into
// Habitat, and the customer returns (real touch).
async function customerLeavesAndReturns(page: Page, customerActions: () => Promise<void>): Promise<void> {
  await tapWorld(page, AWR.emptySpace); // arrives
  await customerActions();
  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await tapWorld(page, AWR.emptySpace); // returns
}

// ============================================================
// Pending-ticket routing
// ============================================================

test("R1. no pending ticket -> the returning customer goes to Discover/Menu", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {});

  expect((await events(page)).wakes).toEqual([
    { route: "DISCOVER_MENU", pending: "NONE" },
    { route: "DISCOVER_MENU", pending: "NONE" },
  ]);
  expect(await attribute(page, "data-view")).toBe("discover");
});

test("R2. ACTIVE + cart lines -> pending: the cart survives Habitat and the return is routed to ownership", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => api.domain.addItem());
  });

  expect((await events(page)).wakes[1]).toEqual({ route: "OWNERSHIP_CONFIRMATION", pending: "ACTIVE_CART" });
  expect(await attribute(page, "data-view")).toBe("ownership");
  expect(await attribute(page, "data-pending")).toBe("ACTIVE_CART");
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1, orderStatus: "NONE" });
});

test("R3. ACTIVE + EMPTY cart is NOT a pending ticket (clearCart leaves the session active)", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => {
      api.domain.addItem();
      api.domain.clearCart();
    });
  });

  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 0 });
  expect((await events(page)).wakes[1]).toEqual({ route: "DISCOVER_MENU", pending: "NONE" });
});

test("R4. CONFIRMATION -> pending: the confirmed order survives Habitat", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, async (api) => {
      api.setMode("success");
      api.domain.addItem();
      await api.domain.submit();
    });
  });

  expect((await events(page)).wakes[1]).toEqual({ route: "OWNERSHIP_CONFIRMATION", pending: "CONFIRMATION" });
  expect(await domain(page)).toMatchObject({ session: "confirmation", orderStatus: "CONFIRMED", cartLines: 1 });
});

test("R5. a customer who arrives before the Domain is ready waits, then is routed once when it is ready", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__u3.gateAuth();
    return (window as any).__u3.mount();
  });
  await freezeTime(page);

  expect(await attribute(page, "data-domain-status")).toBe("BOOTSTRAPPING");
  await tapWorld(page, AWR.emptySpace);
  expect((await events(page)).wakes).toEqual([{ route: "WAIT_NOT_READY", pending: "NOT_READY" }]);
  expect(await attribute(page, "data-view")).toBe("waiting");

  await page.evaluate(() => (window as any).__u3.releaseAuth());
  await page.evaluate(() => (window as any).__u3.domainSettled());

  expect(await attribute(page, "data-domain-status")).toBe("READY");
  expect((await events(page)).wakes).toEqual([
    { route: "WAIT_NOT_READY", pending: "NOT_READY" },
    { route: "DISCOVER_MENU", pending: "NONE" },
  ]);
  expect(await attribute(page, "data-view")).toBe("discover");
});

test("R6. if the Domain never comes up the World stays alive and every wake fails closed to waiting", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);

  expect(await attribute(page, "data-domain-status")).toBe("FAILED");
  expect((await events(page)).errors.some((e) => e.includes("Domain bootstrap failed"))).toBe(true);

  // The World still works for the customer...
  await tapWorld(page, AWR.aul);
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  // ...but a customer is never routed into Discover on a Domain that is not ready.
  expect((await events(page)).wakes).toEqual([{ route: "WAIT_NOT_READY", pending: "NOT_READY" }]);
});

// ============================================================
// UNKNOWN stays protected
// ============================================================

test("U1. UNKNOWN through 5 minutes, Habitat and the customer's return: nothing is reset, retried, rotated, or discarded", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, async (api) => {
      api.setMode("unknown");
      api.domain.addItem();
      await api.domain.submit();
    });
  });

  expect((await events(page)).wakes[1]).toEqual({ route: "OWNERSHIP_CONFIRMATION", pending: "UNRESOLVED" });
  expect(await attribute(page, "data-pending")).toBe("UNRESOLVED");

  // The Domain is exactly as the customer left it.
  expect(await domain(page)).toEqual({
    ready: true,
    session: "awaiting_outcome",
    cartLines: 1,
    orderStatus: "UNCERTAIN",
    canRetryUnknown: true, // still recoverable - by the Domain, not by us
    canRequestSessionEnd: false, // and still refusing to end
  });
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", submissionStatus: "UNKNOWN" });

  const c = await counters(page);
  expect(c.orderIntentCalls).toBe(1); // the one original submit: no retry, ever
  expect(c.signInCalls).toBe(1); // only the boot sign-in
  expect(c.signOutCalls).toBe(0); // no identity rotation
  expect(c.violations).toEqual([]);
  expect(c.portCalls.beginCustomerSession).toBe(1);
});

test("U2. the shell offers no Domain action at all: nothing can reset, clear, retry or abandon a ticket", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, async (api) => {
      api.setMode("unknown");
      api.domain.addItem();
      await api.domain.submit();
    });
  });
  expect(await attribute(page, "data-view")).toBe("ownership");

  // The only control in the shell is the Menu button, and it only asks AWR for its menu.
  expect(await page.locator("[data-experience-shell] button").count()).toBe(1);
  expect(await page.locator("[data-experience-shell] button").getAttribute("data-shell-action")).toBe("menu");
  const text = (await page.locator("[data-experience-shell]").innerText()).toLowerCase();
  for (const word of ["bukan", "reset", "clear", "hapus", "batal", "cancel", "retry", "coba lagi"]) {
    expect(text).not.toContain(word);
  }

  // Using every control the shell has, and every input, changes nothing in the Domain.
  const before = await domain(page);
  await page.locator("[data-shell-action=menu]").click({ force: true });
  await tapWorld(page, AWR.aul);
  await tapWorld(page, AWR.menuPortal);
  await advance(page, 300_000);
  await tapWorld(page, AWR.emptySpace);
  expect(await domain(page)).toEqual(before);
  const c = await counters(page);
  expect(c.orderIntentCalls).toBe(1);
  expect(c.signOutCalls).toBe(0);
  expect(c.violations).toEqual([]);
});

test("U3. UNKNOWN survives a full dispose and remount: the persisted attempt is hydrated as unresolved, never auto-retried", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await u3(page, async (api) => {
    api.setMode("unknown");
    api.domain.addItem();
    await api.domain.submit();
  });
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome", orderStatus: "UNCERTAIN" });

  await u3(page, (api) => api.dispose());
  await u3(page, async (api) => {
    await api.mount(); // a brand-new Host hydrates from the real IndexedDB
    await api.domainSettled();
  });

  expect(await domain(page)).toMatchObject({ ready: true, session: "awaiting_outcome", orderStatus: "UNCERTAIN" });
  await tapWorld(page, AWR.emptySpace);
  expect((await events(page)).wakes).toEqual([{ route: "OWNERSHIP_CONFIRMATION", pending: "UNRESOLVED" }]);

  const c = await counters(page);
  expect(c.orderIntentCalls).toBe(0); // hydration never retries
  expect(c.signOutCalls).toBe(0);
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ submissionStatus: "UNKNOWN" });
});

// ============================================================
// Domain events settle while the kiosk is in Habitat
// ============================================================

test("D1. an in-flight order settles while the kiosk is in Habitat: the Experience neither reacts nor fabricates, and the return sees the real result", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.emptySpace); // the customer submits, then walks away
  await u3(page, (api) => {
    api.setMode("hang");
    api.domain.addItem();
    api.domain.submitBackground();
  });
  await settleFrames(page);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome" });

  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  // Elapsed time did not resolve the ambiguity.
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome" });
  expect((await counters(page)).signOutCalls).toBe(0);

  const wakesBefore = (await events(page)).wakes.length;
  const readsBefore = (await counters(page)).portCalls.getSnapshot;

  // The back end answers while nobody is at the kiosk.
  await u3(page, async (api) => {
    api.releaseHang();
    await api.domain.awaitBackgroundSubmit();
  });
  await settleFrames(page);

  expect(await domain(page)).toMatchObject({ session: "confirmation", orderStatus: "CONFIRMED" });
  expect(await attribute(page, "data-domain-last-event")).toBe("ORDER_OUTCOME_CHANGED");
  expect(await phase(page)).toBe("HABITAT_IDLE"); // a Domain event is not a customer
  expect((await events(page)).wakes.length).toBe(wakesBefore);
  expect((await counters(page)).portCalls.getSnapshot).toBe(readsBefore);

  await tapWorld(page, AWR.emptySpace);
  expect((await events(page)).wakes.at(-1)).toEqual({ route: "OWNERSHIP_CONFIRMATION", pending: "CONFIRMATION" });
});

// ============================================================
// Composition authority over the Domain
// ============================================================

test("A1. across boot, wake, all three thresholds, Habitat and return the Composition touches only its four allowed Domain calls", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => api.domain.addItem());
  });

  const c = await counters(page);
  expect(c.violations).toEqual([]); // any other Domain capability would have thrown and been recorded
  expect(c.portCalls.beginCustomerSession).toBe(1); // once, at mount, never by a timer
  expect(c.portCalls.subscribe).toBe(1);
  expect(c.activeDomainSubscriptions).toBe(1);
  // getSnapshot: exactly one per wake (2 wakes), none from timers.
  expect(c.portCalls.getSnapshot).toBe(2);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.signOutCalls).toBe(0);
});
