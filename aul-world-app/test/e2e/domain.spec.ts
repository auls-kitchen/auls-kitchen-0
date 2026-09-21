// U3 browser e2e - the Kiosk Domain seam, against the REAL Kiosk Host/Runtime/
// Experience projection (built from kiosk/ source, fake Firebase + real
// IndexedDB): pending-ticket routing on return from Habitat, UNKNOWN staying
// protected, Domain events settling while nobody is at the kiosk, and the
// Domain's boot failure paths. The Composition only ever sees a proxied port
// that records every access and throws on any capability outside the five it
// is allowed (the last one, the guarded release, is used by the 5-minute expiry only).

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

// U4 S4a: the shell has no pending-ticket hook at all (the attribute is absent, not blank).
const expectNoPendingAttribute = async (page: Page) =>
  expect(await page.locator("[data-experience-shell]").getAttribute("data-pending")).toBeNull();

// A customer arrives (real touch), the Domain is put into some state by the
// customer's actions, the kiosk goes silent for the full 5 minutes into
// Habitat, and the customer returns (real touch).
//
// U4 S3: the 5-minute expiry now starts ONE guarded release of a releasable
// customer context (ACTIVE / CONFIRMATION). What the returning customer then
// finds depends on how that release ended, so a test says which case it means:
//   "refuse" - the release is answered as REFUSED in place of the Domain, which
//              stays exactly as the customer left it: what these tests pin is how a
//              PENDING ticket routes, and that is unchanged (S4 owns what happens next);
//   "settle" - the REAL release runs, and the customer returns only after it finished
//              (a wait for the outcome, never for a duration).
// UNKNOWN / AWAITING_OUTCOME / idle are never released, so they need neither.
async function customerLeavesAndReturns(page: Page, customerActions: () => Promise<void>, release?: "refuse" | "settle"): Promise<void> {
  await tapWorld(page, AWR.emptySpace); // arrives
  await customerActions();
  if (release === "refuse") await u3(page, (api) => api.setReleaseMode("refuse"));
  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  if (release === "settle") await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
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

test("R2. ACTIVE + cart lines: a cart still in the Domain at the return (the expiry's release refused) fails closed to the neutral unavailable route - never an ownership question", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => api.domain.addItem());
  }, "refuse");

  expect((await events(page)).wakes[1]).toEqual({ route: "UNAVAILABLE_NEUTRAL", pending: "ACTIVE_CART" });
  expect(await attribute(page, "data-view")).toBe("unavailable");
  await expectNoPendingAttribute(page); // the previous customer's ticket kind is never rendered
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1, orderStatus: "NONE" });
});

test("R3. ACTIVE + EMPTY cart (clearCart leaves the session active) is still a releasable context: with the release refused it fails closed, never a guessed Discover", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => {
      api.domain.addItem();
      api.domain.clearCart();
    });
  }, "refuse");

  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 0 });
  expect((await events(page)).wakes[1]).toEqual({ route: "UNAVAILABLE_NEUTRAL", pending: "NONE" });
  expect(await attribute(page, "data-view")).toBe("unavailable");
});

test("R4. CONFIRMATION: a confirmed order still in the Domain at the return (the expiry's release refused) fails closed to the neutral unavailable route", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, async (api) => {
      api.setMode("success");
      api.domain.addItem();
      await api.domain.submit();
    });
  }, "refuse");

  expect((await events(page)).wakes[1]).toEqual({ route: "UNAVAILABLE_NEUTRAL", pending: "CONFIRMATION" });
  expect(await attribute(page, "data-view")).toBe("unavailable");
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

  expect((await events(page)).wakes[1]).toEqual({ route: "PROTECTED_NEUTRAL", pending: "UNRESOLVED" });
  expect(await attribute(page, "data-view")).toBe("protected");
  await expectNoPendingAttribute(page);

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
  expect(await attribute(page, "data-view")).toBe("protected");

  // The shell has exactly two controls: Menu (asks AWR for its menu) and Home/X
  // (a customer-intent control that only reports the phase before the press).
  const buttons = page.locator("[data-experience-shell] button");
  expect(await buttons.count()).toBe(2);
  expect(await buttons.evaluateAll((elements) => elements.map((e) => e.getAttribute("data-shell-action")))).toEqual(["menu", "home"]);
  const text = (await page.locator("[data-experience-shell]").innerText()).toLowerCase();
  for (const word of ["bukan", "reset", "clear", "hapus", "batal", "cancel", "retry", "coba lagi"]) {
    expect(text).not.toContain(word);
  }

  // Using every control the shell has, and every input, changes nothing in the Domain.
  const before = await domain(page);
  await page.locator("[data-shell-action=menu]").click({ force: true });
  await page.locator("[data-shell-action=home]").click({ force: true }); // an UNKNOWN is never taken over
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
  expect((await events(page)).wakes).toEqual([{ route: "PROTECTED_NEUTRAL", pending: "UNRESOLVED" }]);

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
  // The order settled AFTER the expiry, so the return finds a CONFIRMATION nobody has released. With no verdict the
  // lifecycle's routing is the fail-closed neutral route (reconciling it is a later slice): never an ownership question.
  expect((await events(page)).wakes.at(-1)).toEqual({ route: "UNAVAILABLE_NEUTRAL", pending: "CONFIRMATION" });
});

// ============================================================
// Composition authority over the Domain
// ============================================================

test("A1. across boot, wake, all three thresholds, Habitat and return the Composition touches only its five allowed Domain calls", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await customerLeavesAndReturns(page, async () => {
    await u3(page, (api) => api.domain.addItem());
  }, "settle");

  const c = await counters(page);
  expect(c.violations).toEqual([]); // any other Domain capability would have thrown and been recorded
  expect(c.portCalls.beginCustomerSession).toBe(1); // once, at mount, never by a timer
  expect(c.portCalls.subscribe).toBe(1);
  expect(c.activeDomainSubscriptions).toBe(1);
  // getSnapshot: one per wake (2 wakes) and the ONE the 5-minute expiry reads - none from the other timers.
  expect(c.portCalls.getSnapshot).toBe(3);
  // The release seam: used once, by the expiry, and by nothing else.
  expect(c.portCalls.releaseCustomerContext).toBe(1);
  expect(c.orderIntentCalls).toBe(0);
  expect(c.signOutCalls).toBe(0);
});
