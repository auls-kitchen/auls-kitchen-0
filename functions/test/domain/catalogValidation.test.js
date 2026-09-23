const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateProduct } = require("../../src/domain/catalogValidation");

function validProduct(overrides = {}) {
  return {
    id: "prod123",
    name: "Java Aren",
    price: 10000,
    category: "coffee",
    categoryLabel: "Coffee",
    categoryOrder: 1,
    itemOrder: 1,
    ...overrides,
  };
}

test("valid product is accepted", () => {
  const result = validateProduct(validProduct());
  assert.deepEqual(result, { ok: true });
});

test("blank name is rejected", () => {
  const result = validateProduct(validProduct({ name: "   " }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MISSING_PRODUCT_NAME"));
});

test("missing name is rejected", () => {
  const result = validateProduct(validProduct({ name: undefined }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MISSING_PRODUCT_NAME"));
});

test("zero price is rejected", () => {
  const result = validateProduct(validProduct({ price: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_PRICE"));
});

test("negative price is rejected", () => {
  const result = validateProduct(validProduct({ price: -500 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_PRICE"));
});

test("non-numeric price is rejected", () => {
  const result = validateProduct(validProduct({ price: "mahal" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_PRICE"));
});

test("missing category is rejected", () => {
  const result = validateProduct(validProduct({ category: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_CATEGORY"));
});

test("missing categoryLabel is rejected", () => {
  const result = validateProduct(validProduct({ categoryLabel: undefined }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_CATEGORY"));
});

test("non-numeric categoryOrder is rejected", () => {
  const result = validateProduct(validProduct({ categoryOrder: "satu" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_CATEGORY"));
});

test("missing invalid product identity is rejected", () => {
  const result = validateProduct(validProduct({ id: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_PRODUCT_IDENTITY"));
});

test("malformed modifier group (missing name) is rejected", () => {
  const result = validateProduct(
    validProduct({
      modifierGroups: [
        {
          id: "g1",
          name: "",
          selectionType: "single",
          required: true,
          options: [{ id: "o1", name: "Original", price: 0, isDefault: true }],
        },
      ],
    })
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MALFORMED_MODIFIER_GROUP"));
});

test("malformed modifier option (missing id) is rejected", () => {
  const result = validateProduct(
    validProduct({
      modifierGroups: [
        {
          id: "g1",
          name: "Ukuran",
          selectionType: "single",
          required: true,
          options: [{ id: "", name: "Besar", price: 3000, isDefault: false }],
        },
      ],
    })
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MALFORMED_MODIFIER_OPTION"));
});

test("modifier group with empty options array is rejected", () => {
  const result = validateProduct(
    validProduct({
      modifierGroups: [
        { id: "g1", name: "Ukuran", selectionType: "single", required: true, options: [] },
      ],
    })
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("EMPTY_MODIFIER_OPTIONS"));
});

test("absent imageUrl is accepted (optional field)", () => {
  const result = validateProduct(validProduct());
  assert.equal(result.ok, true);
});

test("absent modifierGroups is accepted (optional field)", () => {
  const result = validateProduct(validProduct({ modifierGroups: undefined }));
  assert.equal(result.ok, true);
});

test("missing itemOrder is accepted (non-fatal, defaulted downstream)", () => {
  const result = validateProduct(validProduct({ itemOrder: undefined }));
  assert.equal(result.ok, true);
});

test("extra/legacy fields on the product document are ignored", () => {
  const result = validateProduct(
    validProduct({ recipe: [{ ingredientId: "x", ingredientName: "y", qty: 1 }], legacyField: "whatever" })
  );
  assert.equal(result.ok, true);
});
