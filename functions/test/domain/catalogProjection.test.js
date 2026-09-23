const { test } = require("node:test");
const assert = require("node:assert/strict");
const { projectProduct } = require("../../src/domain/catalogProjection");

function rawProduct(overrides = {}) {
  return {
    id: "prod123",
    name: "Java Aren",
    price: 10000,
    category: "coffee",
    categoryLabel: "Coffee",
    categoryOrder: 1,
    itemOrder: 1,
    recipe: [{ ingredientId: "ing1", ingredientName: "Kopi", qty: 20 }],
    avgCost: 3500,
    hpp: 4200,
    stock: 999,
    ...overrides,
  };
}

test("productId comes from the Firestore document ID", () => {
  const projected = projectProduct(rawProduct({ id: "abc-doc-id" }));
  assert.equal(projected.productId, "abc-doc-id");
});

test("safe fields are included", () => {
  const projected = projectProduct(rawProduct());
  assert.equal(projected.name, "Java Aren");
  assert.equal(projected.category, "coffee");
  assert.equal(projected.categoryLabel, "Coffee");
  assert.equal(projected.categoryOrder, 1);
  assert.equal(projected.itemOrder, 1);
  assert.equal(projected.price, 10000);
});

test("recipe is excluded", () => {
  const projected = projectProduct(rawProduct());
  assert.equal(projected.recipe, undefined);
});

test("ingredient fields are excluded", () => {
  const projected = projectProduct(rawProduct());
  assert.equal(JSON.stringify(projected).includes("ingredientId"), false);
  assert.equal(JSON.stringify(projected).includes("ingredientName"), false);
});

test("stock is excluded", () => {
  const projected = projectProduct(rawProduct());
  assert.equal(projected.stock, undefined);
});

test("cost/HPP is excluded", () => {
  const projected = projectProduct(rawProduct());
  assert.equal(projected.avgCost, undefined);
  assert.equal(projected.hpp, undefined);
});

test("availability/sold-out is excluded (never sourced from product doc)", () => {
  const projected = projectProduct(rawProduct({ soldOut: true, isActive: false }));
  assert.equal(projected.soldOut, undefined);
  assert.equal(projected.isActive, undefined);
});

test("itemOrder defaults to 99 when missing", () => {
  const projected = projectProduct(rawProduct({ itemOrder: undefined }));
  assert.equal(projected.itemOrder, 99);
});

test("absent imageUrl is omitted, not null", () => {
  const projected = projectProduct(rawProduct());
  assert.equal("imageUrl" in projected, false);
});

test("present imageUrl is included verbatim", () => {
  const projected = projectProduct(rawProduct({ imageUrl: "https://res.cloudinary.com/x.jpg" }));
  assert.equal(projected.imageUrl, "https://res.cloudinary.com/x.jpg");
});

test("absent modifierGroups is omitted, not null or empty array", () => {
  const projected = projectProduct(rawProduct());
  assert.equal("modifierGroups" in projected, false);
});

test("modifierGroups project to the locked Modifier/Option shape, excluding option recipe", () => {
  const projected = projectProduct(
    rawProduct({
      modifierGroups: [
        {
          id: "g1",
          name: "Ukuran",
          selectionType: "single",
          required: true,
          legacyGroupField: "ignored",
          options: [
            {
              id: "o1",
              name: "Besar",
              price: 3000,
              isDefault: false,
              recipe: [{ ingredientId: "ing2", ingredientName: "Susu", qty: 50 }],
            },
          ],
        },
      ],
    })
  );
  assert.deepEqual(projected.modifierGroups, [
    {
      id: "g1",
      name: "Ukuran",
      selectionType: "single",
      required: true,
      options: [{ id: "o1", name: "Besar", price: 3000, isDefault: false }],
    },
  ]);
});

test("modifier group/option array order is preserved (not sorted)", () => {
  const projected = projectProduct(
    rawProduct({
      modifierGroups: [
        {
          id: "g2",
          name: "Second",
          selectionType: "single",
          required: false,
          options: [
            { id: "o2", name: "B", price: 0, isDefault: false },
            { id: "o1", name: "A", price: 0, isDefault: true },
          ],
        },
        {
          id: "g1",
          name: "First",
          selectionType: "single",
          required: false,
          options: [{ id: "o1", name: "A", price: 0, isDefault: true }],
        },
      ],
    })
  );
  assert.deepEqual(
    projected.modifierGroups.map((g) => g.id),
    ["g2", "g1"]
  );
  assert.deepEqual(
    projected.modifierGroups[0].options.map((o) => o.id),
    ["o2", "o1"]
  );
});
