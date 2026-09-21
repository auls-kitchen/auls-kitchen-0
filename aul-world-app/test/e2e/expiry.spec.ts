// U4 Slice 2B (S3) browser e2e - the 5-minute expiry -> guarded release wiring, in a
// real page: real AWR World, real Composition, real Kiosk Host/Runtime (fake Firebase,
// real IndexedDB), the real lifecycle timer under Playwright's fake clock.
//
// At CONTEXT_EXPIRED the Composition reads ONE snapshot, applies releasePlanFor, and
// only for a releasable customer context starts ONE release. The verdict is never
// inspected, awaited, or presented. Everything else - Habitat, the World, the routes,
// Home/X, reboot - is unchanged (later slices), so these tests also pin that nothing
// but the release itself is new.
//
// The harness counts every call of the one release seam (portCalls.releaseCustomerContext)
// and can answer it in place of the Domain (refuse / throw / reject / garbage / hold).

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AWR, advance, attribute, boot, counters, domain, events, expectNoProblems, freezeTime, mount, phase, settleFrames, shellAttributes, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

const u3 = <T,>(page: Page, run: (api: any) => T | Promise<T>) => page.evaluate(`(${run.toString()})(window.__u3)`) as Promise<T>;

const releaseCalls = async (page: Page) => (await counters(page)).portCalls.releaseCustomerContext;
const snapshotReads = async (page: Page) => (await counters(page)).portCalls.getSnapshot;

// A customer arrives (a real touch wakes the kiosk), then the Domain is put into some
// state by that customer's actions. Time is frozen, so the 300s boundary is exact.
async function arrive(page: Page, customerActions?: () => Promise<void>): Promise<void> {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await customerActions?.();
}

const withCart = (page: Page) => () => u3(page, (api) => api.domain.addItem());
const withEmptyActive = (page: Page) => () =>
  u3(page, (api) => {
    api.domain.addItem();
    api.domain.clearCart(); // the session stays ACTIVE with no lines
  });
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

// The release itself goes through the real Domain (IndexedDB is real, so a CONFIRMATION
// release finishes a little later): wait for the outcome, never for a duration.
const expectIdle = (page: Page) => expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0, orderStatus: "NONE" });

// No identity change, no extra order call, no other Domain capability.
async function expectNoOtherEffect(page: Page, orderIntentCalls: number): Promise<void> {
  const c = await counters(page);
  expect(c.violations).toEqual([]);
  expect(c.signInCalls).toBe(1);
  expect(c.signOutCalls).toBe(0);
  expect(c.orderIntentCalls).toBe(orderIntentCalls);
  expect(c.portCalls.beginCustomerSession).toBe(1);
}

// ============================================================
// The boundary: exactly at 300s, exactly once
// ============================================================

test("EX1. 299,999 ms: no release call and the Domain untouched; 300,000 ms: exactly ONE release call, and the customer context is gone", async ({ page }) => {
  await arrive(page, withCart(page));
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });

  await advance(page, 299_999);
  expect(await phase(page)).toBe("RELEASED");
  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });

  await advance(page, 1);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect(await releaseCalls(page)).toBe(1);
  await expectIdle(page);
  expect(await snapshotReads(page)).toBe(2); // the arrival's wake + the expiry's ONE read
  await expectNoOtherEffect(page, 0);
});

test("EX2. exactly once per expiry: an hour more of silence, and more time passing, never repeat the release", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 300_000);
  expect(await releaseCalls(page)).toBe(1);

  await advance(page, 3_600_000);
  await advance(page, 300_000);
  expect(await releaseCalls(page)).toBe(1);
  expect(await snapshotReads(page)).toBe(2);
});

// ============================================================
// What is released: ACTIVE + Cart, ACTIVE empty, CONFIRMATION
// ============================================================

test("EX3. ACTIVE + Cart lines is released at expiry", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(1);
  await expectIdle(page);
  await expectNoOtherEffect(page, 0);
});

test("EX4. ACTIVE with an EMPTY Cart is released at expiry too (the session is still customer context)", async ({ page }) => {
  await arrive(page, withEmptyActive(page));
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 0 });

  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(1);
  await expectIdle(page);
  await expectNoOtherEffect(page, 0);
});

test("EX5. CONFIRMATION is released at expiry: the LOCAL result is removed, the order call count and identity are untouched", async ({ page }) => {
  await arrive(page, withConfirmation(page));
  expect(await domain(page)).toMatchObject({ session: "confirmation", cartLines: 1, orderStatus: "CONFIRMED" });
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", hasAuthoritativeResult: true });

  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(1);
  await expectIdle(page);
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ hasAuthoritativeResult: false, submissionStatus: null });
  await expectNoOtherEffect(page, 1); // only the customer's own original order call: the release never touches the back end
});

// ============================================================
// What is never released: UNKNOWN, AWAITING_OUTCOME, idle, not ready
// ============================================================

test("EX6. UNKNOWN: ZERO release calls, and the Domain and its persisted attempt are exactly as the customer left them", async ({ page }) => {
  await arrive(page, withUnknown(page));
  const before = await domain(page);
  expect(before).toMatchObject({ session: "awaiting_outcome", orderStatus: "UNCERTAIN", cartLines: 1 });

  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");
  await advance(page, 3_600_000);

  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toEqual(before);
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ status: "VALID", submissionStatus: "UNKNOWN" });
  expect(await snapshotReads(page)).toBe(2); // the expiry still read ONE snapshot - and decided not to release
  await expectNoOtherEffect(page, 1); // the one original submit: never a retry
});

test("EX7. a submission still IN FLIGHT (AWAITING_OUTCOME): ZERO release calls, and it resolves normally afterwards", async ({ page }) => {
  await arrive(page, () =>
    u3(page, (api) => {
      api.setMode("hang");
      api.domain.addItem();
      api.domain.submitBackground();
    }),
  );
  await settleFrames(page);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome" });

  await advance(page, 300_000);
  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome" });

  await u3(page, async (api) => {
    api.releaseHang();
    await api.domain.awaitBackgroundSubmit();
  });
  expect(await domain(page)).toMatchObject({ session: "confirmation", orderStatus: "CONFIRMED" });
  expect(await releaseCalls(page)).toBe(0); // and it is not released behind the customer's back
});

test("EX8. an idle Domain: nothing to release, so ZERO release calls", async ({ page }) => {
  await arrive(page);
  await advance(page, 300_000);
  expect(await phase(page)).toBe("HABITAT_IDLE");

  expect(await releaseCalls(page)).toBe(0);
  expect(await snapshotReads(page)).toBe(2);
  expect(await domain(page)).toMatchObject({ session: "idle" });
});

test("EX9. a Domain that is not ready (boot failed): ZERO release calls - an unreadable Domain is never released", async ({ page }) => {
  await page.evaluate(() => (window as any).__u3.failAuth(true));
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  expect((await domain(page)).ready).toBe(false);

  await advance(page, 300_000);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect(await releaseCalls(page)).toBe(0);
  expect((await counters(page)).violations).toEqual([]);
});

test("EX9b. a Domain whose snapshot cannot be READ at the expiry: fail closed - ZERO release calls, one error offered to onError, Habitat entered, the Domain untouched", async ({ page }) => {
  await arrive(page, withCart(page));
  await page.evaluate(() => (window as any).__u3.failSnapshots(true)); // the expiry's ONE read will throw

  await advance(page, 300_000);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect(await releaseCalls(page)).toBe(0); // an unreadable Domain is NOT_READY, and NOT_READY never releases
  expect((await events(page)).errors.filter((e) => /snapshot unreadable/.test(e))).toHaveLength(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
  expect((await counters(page)).violations).toEqual([]);
});

// ============================================================
// The verdict is never used: every answer looks identical from the outside
// ============================================================

// What the World mirror shows is AWR's own state; S3 sends it nothing, so it is whatever
// it was just before the expiry, whatever the release answered.
const WORLD_KEYS = ["data-world-presentation", "data-world-camera", "data-aul-mood", "data-aul-interactions"];
const pick = (attributes: Record<string, string>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, attributes[key]]));

for (const mode of ["real", "refuse", "throw", "reject", "garbage"] as const) {
  test(`EX10-${mode}. release answered as "${mode}": exactly one call, and NOTHING about the presentation depends on the verdict`, async ({ page }) => {
    await arrive(page, withCart(page));
    await settleFrames(page);
    await page.evaluate((m) => (window as any).__u3.setReleaseMode(m), mode);
    const worldBefore = pick(await shellAttributes(page), WORLD_KEYS);

    await advance(page, 300_000);
    await settleFrames(page);

    expect(await releaseCalls(page)).toBe(1);
    // Whatever the answer (FRESH for "real", UNAVAILABLE for the rest), the shell shows the same thing:
    // Habitat entered exactly as it always was, and the World exactly as it was.
    const attributes = await shellAttributes(page);
    expect(pick(attributes, ["data-interaction-phase", "data-view", "data-wake-route", "data-domain-status"])).toEqual({
      "data-interaction-phase": "HABITAT_IDLE",
      "data-view": "habitat",
      "data-wake-route": "",
      "data-domain-status": "READY",
    });
    expect("data-pending" in attributes).toBe(false); // U4 S4a: no pending-ticket hook exists any more
    expect(pick(attributes, WORLD_KEYS)).toEqual(worldBefore);
    // The Domain changed only if the REAL release ran; a fake answer touched nothing.
    if (mode === "real") await expectIdle(page);
    else expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });

    // A failing release is offered to onError (once); a refusal or garbage is just a verdict.
    const errors = (await events(page)).errors;
    if (mode === "throw" || mode === "reject") expect(errors.filter((e) => /test release/.test(e))).toHaveLength(1);
    else expect(errors).toEqual([]);
    await expectNoOtherEffect(page, 0);
  });
}

test("EX11. a HELD release: nothing waits for it - Habitat is entered at once, and the Domain changes only when it finally runs", async ({ page }) => {
  await arrive(page, withCart(page));
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));

  await advance(page, 300_000);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect(await attribute(page, "data-view")).toBe("habitat");
  expect(await releaseCalls(page)).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // still held: nothing released yet

  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1);
  await expectIdle(page);
  expect(await releaseCalls(page)).toBe(1); // no second call, no retry
  expect((await events(page)).errors).toEqual([]);
});

test("EX12. dispose DURING a held release: no post-dispose effect, no error, nothing left behind - and the Domain's own release still completes", async ({ page }) => {
  await arrive(page, withCart(page));
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));
  await advance(page, 300_000);
  expect(await releaseCalls(page)).toBe(1);

  await u3(page, (api) => api.dispose());
  const c = await counters(page);
  expect(c.shells).toBe(0);
  expect(c.roots).toBe(0);
  expect(c.canvases).toBe(0);
  expect(c.pendingTimers).toBe(0);
  expect(c.rootListeners).toEqual([]);

  // Now the held Domain release runs: it is not cancelled, and nothing of the disposed Composition reacts.
  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1);
  await expect.poll(() => u3(page, (api) => api.domain.snapshot())).toMatchObject({ session: "idle", cartLines: 0 });
  const after = await counters(page);
  expect(after.shells).toBe(0);
  expect(after.roots).toBe(0);
  expect(after.violations).toEqual([]);
  expect(after.portCalls.releaseCustomerContext).toBe(1);
  expect((await events(page)).errors).toEqual([]);
});

// ============================================================
// The late-timer path: the input evaluates the missed silence first
// ============================================================

test("EX13. an OVERDUE timer: 6 minutes pass with no callback, the next input finds the expiry first - one release call, before the wake", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await u3(page, (api) => api.holdTimers(true)); // the Experience's timeouts never run: a throttled tab
  await tapWorld(page, AWR.emptySpace);
  await u3(page, (api) => api.domain.addItem());

  await advance(page, 360_000);
  expect(await phase(page)).toBe("ACTIVE_STANDBY"); // the timer really is behind
  expect(await releaseCalls(page)).toBe(0);

  await tapWorld(page, AWR.emptySpace); // the next customer's first touch

  expect(await releaseCalls(page)).toBe(1);
  // The missed phases are reported in order BEFORE the input, and the expiry among them started the release.
  expect((await events(page)).phases).toEqual(["ACTIVE_STANDBY", "SPACE_GIVEN", "RELEASED", "CONTEXT_EXPIRED", "HABITAT_IDLE", "ACTIVE_STANDBY"]);
  await expectIdle(page);
  await u3(page, (api) => api.releaseHeldTimers());
  expect(await releaseCalls(page)).toBe(1); // the late callbacks that finally ran added nothing
});

// ============================================================
// The consequence for the next customer (routing itself is unchanged and not driven by the verdict)
// ============================================================

test("EX16. once the release has COMPLETED, the returning customer finds an idle Domain: the wake reads a fresh snapshot and routes to Discover", async ({ page }) => {
  await arrive(page, withCart(page));
  await advance(page, 300_000);
  await expectIdle(page); // wait for the outcome, not for a duration

  await tapWorld(page, AWR.emptySpace);

  expect((await events(page)).wakes).toEqual([
    { route: "DISCOVER_MENU", pending: "NONE" },
    { route: "DISCOVER_MENU", pending: "NONE" },
  ]);
  expect(await snapshotReads(page)).toBe(3); // wake + expiry + wake: the release added no read of its own
  expect(await releaseCalls(page)).toBe(1);
});

// ============================================================
// Nothing else changed: the release seam is used by the expiry and by nothing else
// ============================================================

test("EX14. no other path releases: taps, the Menu button, Home/X, and 15s / 25s of silence make ZERO release calls", async ({ page }) => {
  await arrive(page, withCart(page));
  await tapWorld(page, AWR.aul);
  await tapWorld(page, AWR.menuPortal);
  await page.locator("[data-shell-action=menu]").click({ force: true });
  await advance(page, 15_000);
  await page.locator("[data-shell-action=home]").click({ force: true });
  await advance(page, 26_000); // RELEASED: a takeover is DECIDED (S2A) but nothing is executed
  await page.locator("[data-shell-action=home]").click({ force: true });

  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 });
  expect((await events(page)).homeDecisions.at(-1)).toBe("TAKEOVER_ACTIVE_CART");
});

test("EX15. nothing of the next slice entered: the expiry alone still shows the old behaviour - view habitat, no world reset (the camera stays where the customer left it)", async ({ page }) => {
  await arrive(page, withCart(page));
  await tapWorld(page, AWR.aul); // AUL_FOCUS + happy: a customer-A residue that a RESET_WORLD would clear
  await settleFrames(page);
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");

  await advance(page, 300_000);
  await settleFrames(page);

  expect(await releaseCalls(page)).toBe(1);
  expect(await attribute(page, "data-view")).toBe("habitat");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS"); // S3 emits no RESET_WORLD / RETURN_TO_WORLD of its own
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
});
