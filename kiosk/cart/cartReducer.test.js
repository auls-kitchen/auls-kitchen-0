"use strict";

/**
 * Cart Core unit tests (STEP 54).
 *
 * Run with: node --test kiosk/cart/cartReducer.test.js
 * No new dependencies: uses Node's built-in test runner and assert
 * module only, matching STEP 53's "smallest implementation surface"
 * instruction.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createEmptyCartDraft,
  normalizeSelectedModifiers,
} = require("./cartTypes");

const {
  cartReducer,
  addItem,
  incrementLine,
  decrementLine,
  removeLine,
  setLineModifiers,
  setCustomerName,
  setNotes,
  clearCart,
} = require("./cartReducer");

test("1. empty Cart", () => {
  const state = createEmptyCartDraft();
  assert.deepEqual(state.lines, []);
  assert.equal(state.customerName, null);
  assert.equal(state.notes, null);
});

test("2. add product", () => {
  const state = cartReducer(undefined, addItem({ productId: "p1" }));
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].productId, "p1");
  assert.equal(state.lines[0].quantity, 1);
  assert.deepEqual(state.lines[0].selectedModifiers, []);
});

test("3. merge same product + same modifiers", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "a" }] }));
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "a" }] }));
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].quantity, 2);
});

test("4. modifier ordering does not create a duplicate line", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(
    state,
    addItem({
      productId: "p1",
      selectedModifiers: [
        { groupId: "g1", optionId: "a" },
        { groupId: "g2", optionId: "b" },
      ],
    })
  );
  state = cartReducer(
    state,
    addItem({
      productId: "p1",
      selectedModifiers: [
        { groupId: "g2", optionId: "b" },
        { groupId: "g1", optionId: "a" },
      ],
    })
  );
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].quantity, 2);
});

test("5. separate different modifier selections remain separate lines", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "a" }] }));
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "b" }] }));
  assert.equal(state.lines.length, 2);
});

test("6. increment", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1" }));
  const lineId = state.lines[0].localLineId;
  state = cartReducer(state, incrementLine(lineId));
  assert.equal(state.lines[0].quantity, 2);
});

test("7. decrement", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1", quantity: 2 }));
  const lineId = state.lines[0].localLineId;
  state = cartReducer(state, decrementLine(lineId));
  assert.equal(state.lines[0].quantity, 1);
});

test("8. remove", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1" }));
  const lineId = state.lines[0].localLineId;
  state = cartReducer(state, removeLine(lineId));
  assert.equal(state.lines.length, 0);
});

test("9. zero removal convention (decrement to zero removes the line)", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1", quantity: 1 }));
  const lineId = state.lines[0].localLineId;
  state = cartReducer(state, decrementLine(lineId));
  assert.equal(state.lines.length, 0);
});

test("10. invalid quantity never silently produces zero/negative/fractional", () => {
  const base = createEmptyCartDraft();
  const invalidCases = [0, -1, 1.5, "2", null, NaN];
  for (const quantity of invalidCases) {
    const next = cartReducer(base, addItem({ productId: "p1", quantity }));
    assert.equal(next, base, "quantity=" + quantity + " must no-op (same state reference)");
  }
});

test("10b. mutating a nonexistent line never corrupts existing state", () => {
  const state = cartReducer(undefined, addItem({ productId: "p1" }));
  const untouched = cartReducer(state, incrementLine("does-not-exist"));
  assert.equal(untouched, state);
});

test("11. customerName", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, setCustomerName("Budi"));
  assert.equal(state.customerName, "Budi");
  state = cartReducer(state, setCustomerName(null));
  assert.equal(state.customerName, null);
});

test("12. notes", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, setNotes("less ice"));
  assert.equal(state.notes, "less ice");
});

test("13. clear Cart", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1" }));
  state = cartReducer(state, setCustomerName("Budi"));
  state = cartReducer(state, clearCart());
  assert.deepEqual(state.lines, []);
  assert.equal(state.customerName, null);
  assert.equal(state.notes, null);
});

test("13b. mutation after clear behaves like a fresh Cart", () => {
  let state = cartReducer(undefined, addItem({ productId: "p1" }));
  state = cartReducer(state, clearCart());
  state = cartReducer(state, addItem({ productId: "p2" }));
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].productId, "p2");
});

test("14. immutable state transitions", () => {
  const before = cartReducer(undefined, addItem({ productId: "p1" }));
  const after = cartReducer(before, addItem({ productId: "p2" }));
  assert.notEqual(before, after);
  assert.equal(before.lines.length, 1);
  assert.throws(() => {
    before.lines.push({});
  });
  assert.throws(() => {
    before.lines[0].quantity = 99;
  });
});

test("15. localLineId is unique within a CartDraft", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "a" }] }));
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "b" }] }));
  state = cartReducer(state, addItem({ productId: "p2" }));
  const ids = state.lines.map((l) => l.localLineId);
  assert.equal(new Set(ids).size, ids.length);
});

test("16. display snapshot is non-authoritative and never blocks merging", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(
    state,
    addItem({ productId: "p1", quantity: 1, displaySnapshot: { name: "Kopi", price: 15000 } })
  );
  state = cartReducer(
    state,
    addItem({ productId: "p1", quantity: 1, displaySnapshot: { name: "Kopi (stale)", price: 999999 } })
  );
  // Merge is driven by productId+modifiers only - a wildly different
  // displaySnapshot on the second add must not prevent merging.
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].quantity, 2);
});

test("17. Cart Core never computes or stores a price/total authority", () => {
  const state = cartReducer(undefined, addItem({ productId: "p1", displaySnapshot: { price: 5000 } }));
  assert.equal(Object.prototype.hasOwnProperty.call(state, "total"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, "authoritativeTotal"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lines[0], "unitPrice"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lines[0], "lineTotal"), false);
});

test("18. Cart Core source imports no forbidden dependencies", () => {
  // Scans actual require(...) call targets only - not prose/comments, so
  // documentation that legitimately explains "this module has no
  // Firebase dependency" is not a false positive. This is the real,
  // meaningful boundary check: it fails the moment someone actually
  // imports a forbidden module, and passes regardless of how the code
  // is commented.
  const forbiddenModuleTokens = [
    "firebase",
    "firestore",
    "orderintent",
    "localstorage",
    "sessionstorage",
    "indexeddb",
    "pixi.js",
    "aul-world-runtime",
    "midtrans",
    "qris",
  ];
  const requireCallPattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  const files = ["cartTypes.js", "cartReducer.js"].map((f) => path.join(__dirname, f));

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    // Cart Core is expected to have zero require() calls to anything at
    // all outside its own sibling module (cartReducer -> ./cartTypes).
    let match;
    while ((match = requireCallPattern.exec(source)) !== null) {
      const target = match[1].toLowerCase();
      assert.equal(
        target === "./carttypes" || target === "./cartreducer",
        true,
        path.basename(file) + ' has an unexpected require("' + match[1] + '")'
      );
      for (const token of forbiddenModuleTokens) {
        assert.equal(
          target.includes(token),
          false,
          path.basename(file) + ' must not require a module referencing "' + token + '"'
        );
      }
    }
  }
});

test("19. duplicate modifier identity inside one selection is deduplicated", () => {
  const normalized = normalizeSelectedModifiers([
    { groupId: "g1", optionId: "a" },
    { groupId: "g1", optionId: "a" },
    { groupId: "g2", optionId: "b" },
  ]);
  assert.equal(normalized.length, 2);
});

test("20. mixed Cart lines coexist independently", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, addItem({ productId: "p1" }));
  state = cartReducer(state, addItem({ productId: "p2", quantity: 3 }));
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "x" }] }));
  assert.equal(state.lines.length, 3);
  const p2Line = state.lines.find((l) => l.productId === "p2");
  assert.equal(p2Line.quantity, 3);
});

test("edge I: missing productId is rejected (no-op)", () => {
  const base = createEmptyCartDraft();
  assert.equal(cartReducer(base, addItem({ productId: "" })), base);
  assert.equal(cartReducer(base, addItem({})), base);
});

test("edge J: empty modifier set is valid", () => {
  const state = cartReducer(undefined, addItem({ productId: "p1", selectedModifiers: [] }));
  assert.deepEqual(state.lines[0].selectedModifiers, []);
});

test("edge K: malformed modifier entries are rejected, not guessed at", () => {
  const base = createEmptyCartDraft();
  const next = cartReducer(base, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1" }] }));
  assert.equal(next, base);
});

test("SET_LINE_MODIFIERS merges into an existing equivalent line", () => {
  let state = createEmptyCartDraft();
  state = cartReducer(state, addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "a" }] }));
  state = cartReducer(
    state,
    addItem({ productId: "p1", selectedModifiers: [{ groupId: "g1", optionId: "b" }], quantity: 2 })
  );
  const lineB = state.lines[1];
  state = cartReducer(state, setLineModifiers(lineB.localLineId, [{ groupId: "g1", optionId: "a" }]));
  assert.equal(state.lines.length, 1);
  assert.equal(state.lines[0].quantity, 3);
});

test("unknown action type is a no-op", () => {
  const base = createEmptyCartDraft();
  const next = cartReducer(base, { type: "cart/SOMETHING_ELSE" });
  assert.equal(next, base);
});
