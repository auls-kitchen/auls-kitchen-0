// U3 browser e2e - the customer-input boundary, in a real browser.
//   - a waking touch ALSO activates its interactive target
//   - synthetic (script-dispatched) events and system/AWR/Domain activity never
//     wake or reset the Experience
//   - real hover is not input; only explicit keyboard interaction counts

import { test, expect } from "@playwright/test";
import { AWR, advance, attribute, boot, canvasPoint, counters, events, expectNoProblems, freezeTime, mount, phase, settleFrames, tapWorld } from "./support.ts";

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = await boot(page);
});

test.afterEach(async () => {
  await expectNoProblems(problems);
});

const MENU_BUTTON = "[data-shell-action=menu]";

async function buttonCenter(page: import("@playwright/test").Page) {
  const box = await page.locator(MENU_BUTTON).boundingBox();
  if (!box) throw new Error("Menu button has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// ============================================================
// Waking touch activates its target
// ============================================================

test("W1. one real touch on Aul wakes the Experience AND activates Aul (canvas target)", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  expect(await phase(page)).toBe("HABITAT_IDLE");

  await tapWorld(page, AWR.aul);

  expect(await phase(page)).toBe("ACTIVE_STANDBY"); // the Experience woke...
  expect(await attribute(page, "data-aul-mood")).toBe("happy"); // ...and the touch still reached Aul
  expect(await attribute(page, "data-aul-interactions")).toBe("1");
  await settleFrames(page);
  expect(await attribute(page, "data-world-camera")).toBe("AUL_FOCUS");

  const log = await events(page);
  expect(log.wakes).toEqual([{ route: "DISCOVER_MENU", pending: "NONE" }]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(1); // exactly one Domain read for the wake
});

test("W2. one real touch on the menu portal wakes the Experience AND activates the portal", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await tapWorld(page, AWR.menuPortal);
  await settleFrames(page);

  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect(await attribute(page, "data-world-camera")).toBe("MENU_FOCUS");
});

test("W3. one real click on the shell's Menu button wakes the Experience AND activates the button (DOM target)", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  const at = await buttonCenter(page);
  await page.mouse.click(at.x, at.y);
  await settleFrames(page);

  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  expect((await events(page)).wakes).toHaveLength(1);
});

test("W4. keyboard: only an explicit Enter on the focused Menu button wakes and activates it", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  // Programmatic focus is not customer input.
  await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).focus(), MENU_BUTTON);
  expect(await phase(page)).toBe("HABITAT_IDLE");

  // Keys that are not an explicit activation do nothing.
  for (const key of ["a", "Shift", "Tab", "ArrowDown", "Escape"]) {
    await page.keyboard.press(key);
    // Tab may have moved focus off the button; put it back.
    await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).focus(), MENU_BUTTON);
  }
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).wakes).toEqual([]);

  // Enter with focus NOT on an interactive element: no wake.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  expect(await phase(page)).toBe("HABITAT_IDLE");

  // Enter on the focused button: wakes AND activates it.
  await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).focus(), MENU_BUTTON);
  await page.keyboard.press("Enter");
  await settleFrames(page);
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
});

// ============================================================
// Not customer input
// ============================================================

test("N1. real hover over the World and the shell is NOT input: no wake, no Domain read", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  const aul = await canvasPoint(page, AWR.aul);
  await page.mouse.move(aul.x, aul.y);
  await page.mouse.move(aul.x + 30, aul.y - 20, { steps: 5 });
  const button = await buttonCenter(page);
  await page.mouse.move(button.x, button.y, { steps: 5 });
  await settleFrames(page);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).wakes).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);
  expect(await attribute(page, "data-aul-interactions")).toBe("0");
});

test("N2. system activity - AWR TICK frames and a full minute of silence - never wakes Habitat", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  const before = Number(await attribute(page, "data-world-frame"));
  await page.clock.runFor(2_000);
  await advance(page, 60_000);
  const after = Number(await attribute(page, "data-world-frame"));

  expect(after).toBeGreaterThan(before); // AWR really is ticking...
  expect(await phase(page)).toBe("HABITAT_IDLE"); // ...and that is not customer input
  expect((await events(page)).phases).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);
});

test("N3. script-dispatched (untrusted) events never wake Habitat", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  const aul = await canvasPoint(page, AWR.aul);
  await page.evaluate(
    ({ x, y, selector }) => {
      const root = document.querySelector("[data-aul-world]") as HTMLElement;
      const canvas = document.querySelector("[data-aul-canvas] canvas") as HTMLElement;
      const button = document.querySelector(selector) as HTMLElement;
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", buttons: 1 };
      for (const target of [root, canvas, button]) {
        target.dispatchEvent(new PointerEvent("pointerdown", init));
        target.dispatchEvent(new PointerEvent("pointermove", init));
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
        target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true }));
      }
    },
    { x: aul.x, y: aul.y, selector: MENU_BUTTON },
  );
  await settleFrames(page);

  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).wakes).toEqual([]);
  expect((await events(page)).phases).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);
});

test("N4. AWR-level script activity is not customer input: AWR may react, the Experience does not wake", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  // A script clicks the shell's Menu button (no pointerdown happens).
  await page.evaluate((selector) => (document.querySelector(selector) as HTMLElement).click(), MENU_BUTTON);
  await settleFrames(page);

  // AWR did what AWR does with a MENU_INTENT...
  expect(await attribute(page, "data-world-presentation")).toBe("ORDERING");
  // ...but nothing on the Experience side treated it as a customer.
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).wakes).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);
});

test("N5. Domain activity during Habitat is not customer input", async ({ page }) => {
  await mount(page);
  await freezeTime(page);

  await page.evaluate(() => (window as any).__u3.domain.addItem());
  await settleFrames(page);

  expect(await attribute(page, "data-domain-last-event")).toBe("SESSION_STARTED"); // the Domain did emit...
  expect(await phase(page)).toBe("HABITAT_IDLE"); // ...and the Experience did not wake
  expect((await events(page)).wakes).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);
});

test("N6. system and synthetic activity never restarts an active silence window", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  await tapWorld(page, AWR.emptySpace);

  await advance(page, 14_000);
  // hover, a script click, script events and Domain activity, all inside the window
  const aul = await canvasPoint(page, AWR.aul);
  await page.mouse.move(aul.x, aul.y, { steps: 3 });
  await page.evaluate((selector) => {
    (document.querySelector(selector) as HTMLElement).click();
    document.querySelector("[data-aul-canvas] canvas")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
    (window as any).__u3.domain.addItem();
  }, MENU_BUTTON);
  await advance(page, 1_000);

  expect(await phase(page)).toBe("SPACE_GIVEN"); // 15s since the last REAL input
});

test("N7. a synthetic pointerdown on Aul IS a real AWR interaction (Aul reacts) and is NOT a customer: the Experience stays in Habitat", async ({ page }) => {
  await mount(page);
  await freezeTime(page);
  expect(await attribute(page, "data-aul-interactions")).toBe("0");

  const aul = await canvasPoint(page, AWR.aul);
  const trustedFlag = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector("[data-aul-canvas] canvas") as HTMLElement;
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", buttons: 1, button: 0, isPrimary: true });
    canvas.dispatchEvent(event);
    return event.isTrusted;
  }, aul);
  await settleFrames(page);

  expect(trustedFlag).toBe(false);
  // AWR handled it exactly as it would a tap: OBJECT_INTERACTED reached the bus and the reducer...
  expect(await attribute(page, "data-aul-interactions")).toBe("1");
  expect(await attribute(page, "data-aul-mood")).toBe("happy");
  // ...but no customer was inferred from AWR activity: no wake, no Domain read.
  expect(await phase(page)).toBe("HABITAT_IDLE");
  expect((await events(page)).wakes).toEqual([]);
  expect((await counters(page)).portCalls.getSnapshot).toBe(0);

  // A real touch on Aul afterwards is what wakes it. The synthetic interaction
  // already focused the camera on Aul (AUL_FOCUS), so Aul is drawn at the canvas
  // centre now, not at its authored coordinates.
  await tapWorld(page, { x: 320, y: 200 });
  expect(await phase(page)).toBe("ACTIVE_STANDBY");
  expect(await attribute(page, "data-aul-interactions")).toBe("2");
});
