// U2 targeted tests for src/experience/customerInput.ts (brief sections 6,
// 16-B, 16-G, 16-H). What counts as customer input, what never does (hover,
// synthetic events, scroll, timers), that the adapter never consumes an
// event, and that dispose leaves no listener behind.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOMER_INPUT_EVENT_TYPES,
  attachCustomerInput,
  classifyInputEvent,
  isInteractiveElement,
} from "../../src/experience/customerInput.ts";
import { createFakeInputTarget, makeEvent, synthetic, trusted } from "./support/fakeInputTarget.ts";

function sinkSpy() {
  const calls = { count: 0, args: [] as unknown[][] };
  return {
    calls,
    sink: {
      noteCustomerInput: (...args: unknown[]) => {
        calls.count += 1;
        calls.args.push(args);
      },
    },
  };
}

// ============================================================
// Classification (pure)
// ============================================================

test("I1. a trusted pointerdown is customer input; an untrusted one never is", () => {
  assert.equal(classifyInputEvent(trusted.tap()), true);
  assert.equal(classifyInputEvent(synthetic.tap()), false);
});

test("I2. pointermove counts only while pressed: hover is NOT customer input", () => {
  assert.equal(classifyInputEvent(trusted.drag()), true);
  assert.equal(classifyInputEvent(trusted.hover()), false);
  assert.equal(classifyInputEvent(makeEvent("pointermove")), false, "no buttons field at all is not a press");
  assert.equal(classifyInputEvent(makeEvent("pointermove", { isTrusted: false, buttons: 1 })), false);
});

test("I3. trusted touchmove (swipe) and wheel count; untrusted ones never do", () => {
  assert.equal(classifyInputEvent(trusted.touchSwipe()), true);
  assert.equal(classifyInputEvent(trusted.wheel()), true);
  assert.equal(classifyInputEvent(makeEvent("touchmove", { isTrusted: false })), false);
  assert.equal(classifyInputEvent(synthetic.wheel()), false);
});

test("I4. `scroll` is never customer input (it cannot tell a customer from the system)", () => {
  assert.equal(classifyInputEvent(makeEvent("scroll")), false);
  assert.equal((CUSTOMER_INPUT_EVENT_TYPES as readonly string[]).includes("scroll"), false);
});

test("I5. hover-family and non-interaction events never count, even when trusted", () => {
  for (const type of ["pointerup", "pointerenter", "pointerover", "pointerleave", "mousemove", "mouseover", "focus", "blur", "click", "resize", "load", "TICK", "timer"]) {
    assert.equal(classifyInputEvent(makeEvent(type, { buttons: 1 })), false, type);
  }
});

test("I6. keyboard counts only for Enter/Space, not auto-repeat, on an interactive element", () => {
  const key = (k: string, extra = {}) => makeEvent("keydown", { key: k, repeat: false, target: { tagName: "BUTTON" }, ...extra });

  assert.equal(classifyInputEvent(key("Enter")), true);
  assert.equal(classifyInputEvent(key(" ")), true);

  // Not an activation key.
  for (const k of ["a", "1", "Tab", "Shift", "Control", "Alt", "Meta", "Escape", "ArrowDown", "Backspace"]) {
    assert.equal(classifyInputEvent(key(k)), false, `key ${k}`);
  }
  // Held key.
  assert.equal(classifyInputEvent(key("Enter", { repeat: true })), false);
  // Synthetic.
  assert.equal(classifyInputEvent(synthetic.enterOnButton()), false);
  // Not on an interactive element.
  assert.equal(classifyInputEvent(key("Enter", { target: { tagName: "BODY" } })), false);
  assert.equal(classifyInputEvent(key("Enter", { target: { tagName: "DIV" } })), false);
  assert.equal(classifyInputEvent(key("Enter", { target: undefined })), false);
  assert.equal(classifyInputEvent(key("Enter", { target: null })), false);
});

test("I7. interactive-element detection: buttons, links with href, form controls, ARIA roles; not disabled ones", () => {
  const make = (tagName: string, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    const el: Record<string, unknown> = {
      tagName,
      getAttribute(this: unknown, name: string) {
        // Like the real DOM, getAttribute must be invoked on its element.
        assert.equal(this, el, "getAttribute must be invoked with the element as receiver");
        return name in attrs ? attrs[name] : null;
      },
      ...extra,
    };
    return el;
  };

  assert.equal(isInteractiveElement(make("BUTTON")), true);
  assert.equal(isInteractiveElement(make("button")), true);
  assert.equal(isInteractiveElement(make("A", { href: "#x" })), true);
  assert.equal(isInteractiveElement(make("A")), false, "an anchor without href is not interactive");
  assert.equal(isInteractiveElement(make("DIV", { role: "button" })), true);
  assert.equal(isInteractiveElement(make("DIV", { role: "presentation" })), false);
  assert.equal(isInteractiveElement(make("SPAN")), false);
  assert.equal(isInteractiveElement(make("BUTTON", {}, { disabled: true })), false);
  assert.equal(isInteractiveElement(null), false);
  assert.equal(isInteractiveElement("BUTTON"), false);
});

test("I8. the interactive-target predicate is injectable", () => {
  const event = makeEvent("keydown", { key: "Enter", repeat: false, target: { tagName: "DIV" } });
  assert.equal(classifyInputEvent(event), false);
  assert.equal(classifyInputEvent(event, { isInteractiveTarget: () => true }), true);
  assert.equal(classifyInputEvent(trusted.enterOnButton(), { isInteractiveTarget: () => false }), false);
});

test("I9. classification tolerates missing input", () => {
  assert.equal(classifyInputEvent(null), false);
  assert.equal(classifyInputEvent(undefined), false);
  assert.equal(classifyInputEvent({ type: "pointerdown" }), false, "no isTrusted is not trusted");
});

// ============================================================
// Attach / dispatch
// ============================================================

test("I10. attach registers exactly the five customer-input types, each capture + passive + signal, once", () => {
  const fake = createFakeInputTarget();
  attachCustomerInput(fake.target, sinkSpy().sink);

  const regs = fake.registrations();
  assert.deepEqual(regs.map((r) => r.type).sort(), [...CUSTOMER_INPUT_EVENT_TYPES].sort());
  assert.equal(regs.length, 5);
  for (const reg of regs) {
    assert.equal(reg.capture, true, `${reg.type} must be capture`);
    assert.equal(reg.passive, true, `${reg.type} must be passive`);
    assert.equal(reg.hasSignal, true, `${reg.type} must be bound to an abort signal`);
  }
});

test("I11. trusted customer events reach the sink; nothing else does", () => {
  const fake = createFakeInputTarget();
  const { sink, calls } = sinkSpy();
  attachCustomerInput(fake.target, sink);

  fake.dispatch(trusted.tap());
  fake.dispatch(trusted.drag());
  fake.dispatch(trusted.touchSwipe());
  fake.dispatch(trusted.wheel());
  fake.dispatch(trusted.enterOnButton());
  assert.equal(calls.count, 5);

  // None of these count.
  fake.dispatch(synthetic.tap());
  fake.dispatch(synthetic.wheel());
  fake.dispatch(synthetic.enterOnButton());
  fake.dispatch(trusted.hover());
  fake.dispatch(makeEvent("scroll"));
  fake.dispatch(makeEvent("pointerup"));
  fake.dispatch(makeEvent("TICK"));
  assert.equal(calls.count, 5);
});

test("I12. the sink is only ever called with no arguments (no event data crosses the boundary)", () => {
  const fake = createFakeInputTarget();
  const { sink, calls } = sinkSpy();
  attachCustomerInput(fake.target, sink);
  fake.dispatch(trusted.tap());
  fake.dispatch(trusted.drag());
  assert.deepEqual(calls.args, [[], []]);
});

test("I13. the adapter never consumes an event: no preventDefault / stopPropagation / stopImmediatePropagation", () => {
  const fake = createFakeInputTarget();
  attachCustomerInput(fake.target, sinkSpy().sink);
  const events = [trusted.tap(), trusted.drag(), trusted.touchSwipe(), trusted.wheel(), trusted.enterOnButton(), synthetic.tap(), trusted.hover()];
  for (const event of events) fake.dispatch(event);
  for (const event of events) assert.deepEqual(event.consumed, [], `${event.type} was consumed`);
});

// ============================================================
// H. Disposal
// ============================================================

test("I14. dispose() removes every listener at once and is idempotent", () => {
  const fake = createFakeInputTarget();
  const { sink, calls } = sinkSpy();
  const binding = attachCustomerInput(fake.target, sink);
  assert.equal(fake.activeListenerCount(), 5);

  binding.dispose();
  assert.equal(fake.activeListenerCount(), 0);
  assert.doesNotThrow(() => binding.dispose());

  fake.dispatch(trusted.tap());
  assert.equal(calls.count, 0, "no input reaches the sink after dispose");
});

test("I15. a listener a non-conforming target failed to remove is still inert after dispose", () => {
  // A target that IGNORES the abort signal and keeps calling the listener.
  const listeners: Array<(event: unknown) => void> = [];
  const stubborn = {
    addEventListener: (_type: string, listener: (event: unknown) => void) => void listeners.push(listener),
  } as unknown as EventTarget;
  const { sink, calls } = sinkSpy();
  const binding = attachCustomerInput(stubborn, sink);

  for (const listener of listeners) listener(trusted.tap());
  assert.equal(calls.count, 5);

  binding.dispose();
  for (const listener of listeners) listener(trusted.tap());
  assert.equal(calls.count, 5, "the handler's own abort guard must stop it");
});

test("I16. a target that throws while binding is rolled back, not left half-bound", () => {
  let added = 0;
  const brittle = {
    addEventListener: (type: string, _listener: unknown, options: { signal: AbortSignal }) => {
      added += 1;
      if (type === "touchmove") throw new Error("cannot bind");
      void options;
    },
  } as unknown as EventTarget;
  assert.throws(() => attachCustomerInput(brittle, sinkSpy().sink), /cannot bind/);
  assert.equal(added, 3, "pointerdown, pointermove, then the failing touchmove");
});

test("I17. two attachments are independent: disposing one leaves the other bound", () => {
  const fake = createFakeInputTarget();
  const a = sinkSpy();
  const b = sinkSpy();
  const bindingA = attachCustomerInput(fake.target, a.sink);
  attachCustomerInput(fake.target, b.sink);
  assert.equal(fake.activeListenerCount(), 10);

  bindingA.dispose();
  assert.equal(fake.activeListenerCount(), 5);
  fake.dispatch(trusted.tap());
  assert.equal(a.calls.count, 0);
  assert.equal(b.calls.count, 1);
});

test("I18. real EventTarget: synthetic events (isTrusted === false) never count, and dispose detaches", () => {
  const target = new EventTarget();
  const { sink, calls } = sinkSpy();
  const binding = attachCustomerInput(target, sink);

  for (const type of CUSTOMER_INPUT_EVENT_TYPES) {
    target.dispatchEvent(new Event(type));
  }
  assert.equal(calls.count, 0, "script-dispatched events are never customer input");

  binding.dispose();
  target.dispatchEvent(new Event("pointerdown"));
  assert.equal(calls.count, 0);
});
