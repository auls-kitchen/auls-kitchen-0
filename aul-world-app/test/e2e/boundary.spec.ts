// U4 Slice 2B (S4b) browser e2e - wiring the S4a context-boundary primitive into the
// existing expiry/wake/reboot flows, in a real page: real AWR World, real Composition,
// real Kiosk Host/Runtime (fake Firebase, real IndexedDB).
//
// What this file proves that no earlier spec does:
//   - a FRESH release is allowed to reset the World (mood/camera), an UNAVAILABLE one
//     is not, and UNKNOWN/NOTHING_TO_RELEASE never even attempt a release;
//   - the stale-context race: a customer A's expiry release held in flight while
//     customer B arrives - B never consumes A's verdict, A's late settlement can never
//     reset the World or change B's presentation, and B evaluates its OWN fresh
//     snapshot (the one, bounded, extra read the contested path is allowed);
//   - touch (a customer-caused World event) can veto the OPTIONAL World reset without
//     ever blocking the release itself or authorizing anything on its own;
//   - dispose during a held reconciliation leaves nothing behind;
//   - the reboot boundary reconciles a hydrated CONFIRMATION (and only that - never
//     UNKNOWN/AWAITING_OUTCOME), and only when a waiter is actually pending - no
//     unconditional boot read exists.

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
const lastWake = async (page: Page) => (await events(page)).wakes.at(-1);
const releaseCalls = async (page: Page) => (await counters(page)).portCalls.releaseCustomerContext;
const snapshotReads = async (page: Page) => (await counters(page)).portCalls.getSnapshot;

async function arrive(page: Page, customerActions?: () => Promise<void>): Promise<void> {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace); // arrives on an empty Domain: nothing to reconcile yet
  await customerActions?.();
}

// ============================================================
// FRESH permits the reset; UNAVAILABLE, UNKNOWN and NOTHING_TO_RELEASE never do
// ============================================================

test("BD1. expiry + FRESH + current owner: the World reset IS allowed - mood and camera return to idle/WORLD_VIEW", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem()));
  // Untouched world at expiry time: worldQuiet holds for the owning token.
  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(1);
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("idle");
  expect(await attribute(page, "data-world-camera")).toBe("WORLD_VIEW");
  expect(await attribute(page, "data-world-presentation")).toBe("WORLD");
});

test("BD2. expiry + UNAVAILABLE (refused): the release still ran once, but NO World reset - Aul's focus and mood survive", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem()));
  await tapWorld(page, AWR.aul); // mood happy, camera AUL_FOCUS
  await settleFrames(page);
  await page.evaluate(() => (window as any).__u3.setReleaseMode("refuse"));

  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // refused: untouched
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
});

test("BD3. expiry + UNKNOWN: ZERO release calls, so categorically no World reset either", async ({ page }) => {
  await arrive(page, () =>
    u3(page, async (api) => {
      api.setMode("unknown");
      api.domain.addItem();
      await api.domain.submit();
    }),
  );
  await tapWorld(page, AWR.aul);
  await settleFrames(page);

  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome", orderStatus: "UNCERTAIN" });
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
});

test("BD4. expiry + NOTHING_TO_RELEASE (idle Domain): ZERO release calls, no reset - FRESH does not universally mean reset", async ({ page }) => {
  await arrive(page); // nothing added: idle
  await tapWorld(page, AWR.aul);
  await settleFrames(page);

  await advance(page, 300_000);

  expect(await releaseCalls(page)).toBe(0);
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
});

// ============================================================
// The A -> B race: a stale continuation can never mutate a newer context
// ============================================================

test("BD5. A's expiry release held in flight, B arrives: B waits (never joins/consumes A's verdict), A's late FRESH settlement resets NOTHING, and B presents from its OWN fresh read", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem()));
  await tapWorld(page, AWR.aul); // A's own world touch, BEFORE expiry: mood happy, camera AUL_FOCUS
  await settleFrames(page);
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));

  await advance(page, 300_000); // A's expiry starts a held release under A's own (pre-existing) epoch
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect(await releaseCalls(page)).toBe(1);
  const readsAtBWake = await snapshotReads(page);

  await tapWorld(page, AWR.emptySpace); // B arrives while A is still settling (contested wake)
  // B must not have consumed A's (not-yet-known) verdict, and must not have released again.
  expect(await releaseCalls(page)).toBe(1);
  expect(await domain(page)).toMatchObject({ session: "active", cartLines: 1 }); // A's release hasn't run yet

  // A's held release finally runs (real, FRESH for an ACTIVE context).
  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1);

  // A's stale continuation must never reset the World: mood/camera survive exactly as A left them.
  await settleFrames(page);
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
  // B's OWN presentation: once A's release freed the Domain, B's own fresh read finds it idle -
  // NONE_TO_RELEASE, so B releases nothing of its own and is routed fresh.
  await expect.poll(() => lastWake(page)).toEqual({ route: "DISCOVER_MENU", pending: "NONE" });
  expect(await releaseCalls(page)).toBe(1); // B never called release itself: nothing left to release
  // B's wake costs its own one read (as any wake does), PLUS exactly one more for the contested
  // path's fresh re-read after A settled - never more than that.
  expect(await snapshotReads(page)).toBe(readsAtBWake + 2);
});

test("BD6. an uncontested wake (idle Domain) still reads exactly once - the contested path's extra read is not paid on the fast path", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  const before = await snapshotReads(page);
  await tapWorld(page, AWR.emptySpace);
  expect(await snapshotReads(page)).toBe(before + 1);
  expect(await releaseCalls(page)).toBe(0);
});

// ============================================================
// touch: secondary only - it can veto the reset, but never blocks the release itself
// ============================================================

test("BD7. a customer's own earlier World touch vetoes the reset at their own expiry - but the release itself still fully succeeds", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem()));
  await tapWorld(page, AWR.aul); // touches the World WHILE still active (not a wake: not from Habitat)
  await settleFrames(page);
  expect(await phase(page)).toBe("ACTIVE_STANDBY"); // a real press restarted the window

  await advance(page, 300_000); // the SAME epoch's own expiry, now

  expect(await releaseCalls(page)).toBe(1);
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 }); // released for real
  // ...but the reset was vetoed: mood/camera stay exactly as the earlier touch left them.
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");
});

// ============================================================
// Dispose during a held reconciliation leaves nothing behind
// ============================================================

test("BD8. dispose while a reconciliation's release is held: no reset, no error, nothing left behind - and the held Domain call still completes harmlessly afterwards", async ({ page }) => {
  await arrive(page, () => u3(page, (api) => api.domain.addItem()));
  await page.evaluate(() => (window as any).__u3.setReleaseMode("hold"));
  await advance(page, 300_000);
  expect(await releaseCalls(page)).toBe(1);

  await u3(page, (api) => api.dispose());
  const before = await counters(page);
  expect(before.shells).toBe(0);
  expect(before.roots).toBe(0);
  expect(before.pendingTimers).toBe(0);

  expect(await page.evaluate(() => (window as any).__u3.releaseHeld())).toBe(1);
  await expect.poll(() => u3(page, (api) => api.domain.snapshot())).toMatchObject({ session: "idle", cartLines: 0 });
  const after = await counters(page);
  expect(after.shells).toBe(0);
  expect(after.roots).toBe(0);
  expect(after.violations).toEqual([]);
  expect((await events(page)).errors).toEqual([]);
});

// ============================================================
// Reboot boundary: CONFIRMATION only, and only when a waiter is pending
// ============================================================

test("BD9. reboot: a hydrated CONFIRMATION with a waiter pending is reconciled for real - Discover, no persisted result left behind", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await u3(page, async (api) => {
    api.domain.addItem();
    await api.domain.submit();
  });
  expect(await domain(page)).toMatchObject({ session: "confirmation", orderStatus: "CONFIRMED" });
  await u3(page, (api) => api.dispose());

  // Remount under the SAME persisted identity, gated so a waiter forms BEFORE READY (R5's pattern).
  await page.evaluate(() => (window as any).__u3.gateAuth());
  await page.evaluate(() => (window as any).__u3.mount());
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  expect(await attribute(page, "data-view")).toBe("waiting");
  const readsBeforeReady = await snapshotReads(page);

  await page.evaluate(() => (window as any).__u3.releaseAuth());
  await u3(page, (api) => api.domainSettled());

  await expect.poll(() => lastWake(page)).toEqual({ route: "DISCOVER_MENU", pending: "NONE" });
  await expect.poll(() => domain(page)).toMatchObject({ session: "idle", cartLines: 0 });
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ hasAuthoritativeResult: false });
  expect(await releaseCalls(page)).toBe(1);
  // The reboot boundary reused the SAME read the waiter reroute always made - no extra boot read.
  expect(await snapshotReads(page)).toBe(readsBeforeReady + 1);
});

test("BD10. reboot: a hydrated UNKNOWN with a waiter pending stays PROTECTED - ZERO release calls, nothing cleared", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  await u3(page, async (api) => {
    api.setMode("unknown");
    api.domain.addItem();
    await api.domain.submit();
  });
  await u3(page, (api) => api.dispose());

  await page.evaluate(() => (window as any).__u3.gateAuth());
  await page.evaluate(() => (window as any).__u3.mount());
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);
  expect(await attribute(page, "data-view")).toBe("waiting");

  await page.evaluate(() => (window as any).__u3.releaseAuth());
  await u3(page, (api) => api.domainSettled());

  await expect.poll(() => lastWake(page)).toEqual({ route: "PROTECTED_NEUTRAL", pending: "UNRESOLVED" });
  expect(await releaseCalls(page)).toBe(0);
  expect(await domain(page)).toMatchObject({ session: "awaiting_outcome", orderStatus: "UNCERTAIN" });
  expect(await u3(page, (api) => api.domain.persisted())).toMatchObject({ submissionStatus: "UNKNOWN" });
});

test("BD11. no unconditional boot read: mount, let hydration finish, nobody ever arrives - ZERO getSnapshot calls and ZERO release calls", async ({ page }) => {
  await mount(page);
  expect(await snapshotReads(page)).toBe(0);
  expect(await releaseCalls(page)).toBe(0);
  const status = await attribute(page, "data-domain-status");
  expect(status).toBe("READY");
  expect(await snapshotReads(page)).toBe(0); // still zero: READY alone never reads (no waiter was pending)
});
