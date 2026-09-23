"use strict";

/**
 * Cart Core reducer - pure, immutable state transitions only.
 *
 * No I/O. No Firebase. No browser storage. No idempotency keys. No
 * OrderIntent calls. No knowledge of Customer Session, Auth identity, or
 * Payment. Submission state belongs to a later, separate scope (STEP 53
 * blueprint) - this module never sees it.
 */

const {
  createEmptyCartDraft,
  generateLocalLineId,
  isPositiveInteger,
  isNonEmptyString,
  normalizeSelectedModifiers,
  computeLineKey,
} = require("./cartTypes");

const ADD_ITEM = "cart/ADD_ITEM";
const INCREMENT_LINE = "cart/INCREMENT_LINE";
const DECREMENT_LINE = "cart/DECREMENT_LINE";
const REMOVE_LINE = "cart/REMOVE_LINE";
const SET_LINE_MODIFIERS = "cart/SET_LINE_MODIFIERS";
const SET_CUSTOMER_NAME = "cart/SET_CUSTOMER_NAME";
const SET_NOTES = "cart/SET_NOTES";
const CLEAR_CART = "cart/CLEAR_CART";

const ActionTypes = Object.freeze({
  ADD_ITEM: ADD_ITEM,
  INCREMENT_LINE: INCREMENT_LINE,
  DECREMENT_LINE: DECREMENT_LINE,
  REMOVE_LINE: REMOVE_LINE,
  SET_LINE_MODIFIERS: SET_LINE_MODIFIERS,
  SET_CUSTOMER_NAME: SET_CUSTOMER_NAME,
  SET_NOTES: SET_NOTES,
  CLEAR_CART: CLEAR_CART,
});

// --- action creators: pure object builders, no dispatch, no side effects ---

function addItem(input) {
  const safeInput = input || {};
  return {
    type: ADD_ITEM,
    payload: {
      productId: safeInput.productId,
      quantity: safeInput.quantity === undefined ? 1 : safeInput.quantity,
      selectedModifiers: safeInput.selectedModifiers,
      displaySnapshot: safeInput.displaySnapshot,
    },
  };
}
function incrementLine(localLineId) {
  return { type: INCREMENT_LINE, payload: { localLineId: localLineId } };
}
function decrementLine(localLineId) {
  return { type: DECREMENT_LINE, payload: { localLineId: localLineId } };
}
function removeLine(localLineId) {
  return { type: REMOVE_LINE, payload: { localLineId: localLineId } };
}
function setLineModifiers(localLineId, selectedModifiers) {
  return {
    type: SET_LINE_MODIFIERS,
    payload: { localLineId: localLineId, selectedModifiers: selectedModifiers },
  };
}
function setCustomerName(customerName) {
  return { type: SET_CUSTOMER_NAME, payload: { customerName: customerName } };
}
function setNotes(notes) {
  return { type: SET_NOTES, payload: { notes: notes } };
}
function clearCart() {
  return { type: CLEAR_CART };
}

// --- immutability helpers (shallow freeze; documented, not claimed deep) ---

function freezeLine(line) {
  return Object.freeze(
    Object.assign({}, line, {
      selectedModifiers: Object.freeze(line.selectedModifiers.slice()),
      displaySnapshot: Object.freeze(Object.assign({}, line.displaySnapshot)),
    })
  );
}

function freezeDraft(draft) {
  return Object.freeze(
    Object.assign({}, draft, {
      lines: Object.freeze(draft.lines.map(freezeLine)),
    })
  );
}

function findLineIndexById(lines, localLineId) {
  return lines.findIndex(function (line) {
    return line.localLineId === localLineId;
  });
}

function findLineIndexByKey(lines, lineKey, excludeLocalLineId) {
  return lines.findIndex(function (line) {
    return (
      line.localLineId !== excludeLocalLineId &&
      computeLineKey(line.productId, line.selectedModifiers) === lineKey
    );
  });
}

// --- per-action handlers ---

function handleAddItem(state, payload) {
  const safePayload = payload || {};
  const productId = safePayload.productId;
  const quantity = safePayload.quantity === undefined ? 1 : safePayload.quantity;

  if (!isNonEmptyString(productId)) return state; // missing productId: no-op
  if (!isPositiveInteger(quantity)) return state; // invalid quantity: no-op, never zero/negative/fractional

  const normalizedModifiers = normalizeSelectedModifiers(safePayload.selectedModifiers);
  if (normalizedModifiers === null) return state; // malformed modifier selection: no-op

  const lineKey = computeLineKey(productId, normalizedModifiers);
  const existingIndex = findLineIndexByKey(state.lines, lineKey, null);

  if (existingIndex !== -1) {
    const nextLines = state.lines.slice();
    const existing = nextLines[existingIndex];
    nextLines[existingIndex] = Object.assign({}, existing, {
      quantity: existing.quantity + quantity,
    });
    return freezeDraft(Object.assign({}, state, { lines: nextLines }));
  }

  const displaySnapshot =
    safePayload.displaySnapshot && typeof safePayload.displaySnapshot === "object"
      ? Object.assign({}, safePayload.displaySnapshot)
      : {};

  const newLine = {
    localLineId: generateLocalLineId(),
    productId: productId,
    quantity: quantity,
    selectedModifiers: normalizedModifiers,
    displaySnapshot: displaySnapshot,
  };

  return freezeDraft(Object.assign({}, state, { lines: state.lines.concat([newLine]) }));
}

function handleIncrementLine(state, payload) {
  const index = findLineIndexById(state.lines, payload && payload.localLineId);
  if (index === -1) return state;

  const nextLines = state.lines.slice();
  const existing = nextLines[index];
  nextLines[index] = Object.assign({}, existing, { quantity: existing.quantity + 1 });
  return freezeDraft(Object.assign({}, state, { lines: nextLines }));
}

function handleDecrementLine(state, payload) {
  const index = findLineIndexById(state.lines, payload && payload.localLineId);
  if (index === -1) return state;

  const existing = state.lines[index];
  const nextQuantity = existing.quantity - 1;
  const nextLines = state.lines.slice();

  if (nextQuantity <= 0) {
    // Cart convention: decrementing to zero removes the line entirely,
    // rather than ever retaining a zero/negative quantity.
    nextLines.splice(index, 1);
    return freezeDraft(Object.assign({}, state, { lines: nextLines }));
  }

  nextLines[index] = Object.assign({}, existing, { quantity: nextQuantity });
  return freezeDraft(Object.assign({}, state, { lines: nextLines }));
}

function handleRemoveLine(state, payload) {
  const index = findLineIndexById(state.lines, payload && payload.localLineId);
  if (index === -1) return state; // idempotent no-op

  const nextLines = state.lines.slice();
  nextLines.splice(index, 1);
  return freezeDraft(Object.assign({}, state, { lines: nextLines }));
}

function handleSetLineModifiers(state, payload) {
  const localLineId = payload && payload.localLineId;
  const index = findLineIndexById(state.lines, localLineId);
  if (index === -1) return state;

  const normalizedModifiers = normalizeSelectedModifiers(payload.selectedModifiers);
  if (normalizedModifiers === null) return state;

  const existing = state.lines[index];
  const newKey = computeLineKey(existing.productId, normalizedModifiers);
  const duplicateIndex = findLineIndexByKey(state.lines, newKey, localLineId);

  if (duplicateIndex !== -1) {
    // Changing modifiers made this line equivalent to another existing
    // line. Merge into it (sum quantities) and drop this one, so the
    // "one line per productId+modifiers" invariant holds at all times,
    // not only at add-time.
    const nextLines = state.lines.slice();
    const target = nextLines[duplicateIndex];
    nextLines[duplicateIndex] = Object.assign({}, target, {
      quantity: target.quantity + existing.quantity,
    });
    const removeAt = nextLines.findIndex(function (line) {
      return line.localLineId === localLineId;
    });
    nextLines.splice(removeAt, 1);
    return freezeDraft(Object.assign({}, state, { lines: nextLines }));
  }

  const nextLines = state.lines.slice();
  nextLines[index] = Object.assign({}, existing, { selectedModifiers: normalizedModifiers });
  return freezeDraft(Object.assign({}, state, { lines: nextLines }));
}

function handleSetCustomerName(state, payload) {
  const customerName = payload && "customerName" in payload ? payload.customerName : undefined;
  if (customerName !== null && typeof customerName !== "string") return state;
  return freezeDraft(Object.assign({}, state, { customerName: customerName }));
}

function handleSetNotes(state, payload) {
  const notes = payload && "notes" in payload ? payload.notes : undefined;
  if (notes !== null && typeof notes !== "string") return state;
  return freezeDraft(Object.assign({}, state, { notes: notes }));
}

/**
 * Cart Core reducer. Pure: (state, action) -> next state. Never performs
 * I/O, never touches Firebase/browser storage, never generates an
 * idempotency key, never knows about Customer Session, Auth identity, or
 * Payment. Unknown action types are a no-op (returns the same state
 * reference, unchanged).
 */
function cartReducer(state, action) {
  const currentState = state === undefined ? createEmptyCartDraft() : state;
  if (!action || typeof action.type !== "string") return currentState;

  switch (action.type) {
    case ADD_ITEM:
      return handleAddItem(currentState, action.payload);
    case INCREMENT_LINE:
      return handleIncrementLine(currentState, action.payload);
    case DECREMENT_LINE:
      return handleDecrementLine(currentState, action.payload);
    case REMOVE_LINE:
      return handleRemoveLine(currentState, action.payload);
    case SET_LINE_MODIFIERS:
      return handleSetLineModifiers(currentState, action.payload);
    case SET_CUSTOMER_NAME:
      return handleSetCustomerName(currentState, action.payload);
    case SET_NOTES:
      return handleSetNotes(currentState, action.payload);
    case CLEAR_CART:
      return createEmptyCartDraft();
    default:
      return currentState;
  }
}

module.exports = {
  ActionTypes: ActionTypes,
  addItem: addItem,
  incrementLine: incrementLine,
  decrementLine: decrementLine,
  removeLine: removeLine,
  setLineModifiers: setLineModifiers,
  setCustomerName: setCustomerName,
  setNotes: setNotes,
  clearCart: clearCart,
  cartReducer: cartReducer,
};
