const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalizeCatalog,
  canonicalizeValue,
  compareProducts,
} = require("../../src/domain/catalogCanonicalization");

function product(overrides = {}) {
  return { productId: "p1", categoryOrder: 1, itemOrder: 1, name: "X", ...overrides };
}

test("product ordering is deterministic by categoryOrder then itemOrder", () => {
  const products = [
    product({ productId: "b", categoryOrder: 2, itemOrder: 1 }),
    product({ productId: "a", categoryOrder: 1, itemOrder: 2 }),
    product({ productId: "c", categoryOrder: 1, itemOrder: 1 }),
  ];
  const { sortedProducts } = canonicalizeCatalog(products);
  assert.deepEqual(sortedProducts.map((p) => p.productId), ["c", "a", "b"]);
});

test("productId tie-break is deterministic when categoryOrder and itemOrder are equal", () => {
  const products = [
    product({ productId: "zeta", categoryOrder: 1, itemOrder: 1 }),
    product({ productId: "alpha", categoryOrder: 1, itemOrder: 1 }),
    product({ productId: "mid", categoryOrder: 1, itemOrder: 1 }),
  ];
  const { sortedProducts } = canonicalizeCatalog(products);
  assert.deepEqual(sortedProducts.map((p) => p.productId), ["alpha", "mid", "zeta"]);
});

test("compareProducts is a stable, reusable comparator", () => {
  assert.equal(compareProducts(product({ categoryOrder: 1 }), product({ categoryOrder: 2 })) < 0, true);
  assert.equal(compareProducts(product({ categoryOrder: 2 }), product({ categoryOrder: 1 })) > 0, true);
});

test("object keys are recursively alphabetized", () => {
  const canonical = canonicalizeValue({ zeta: 1, alpha: { delta: 2, beta: 3 } });
  assert.equal(JSON.stringify(canonical), '{"alpha":{"beta":3,"delta":2},"zeta":1}');
});

test("undefined values are omitted from canonicalized output", () => {
  const canonical = canonicalizeValue({ a: 1, b: undefined, c: 3 });
  assert.equal(JSON.stringify(canonical), '{"a":1,"c":3}');
});

test("modifier group array order is preserved through canonicalization (not sorted)", () => {
  const products = [
    product({
      productId: "p1",
      modifierGroups: [{ id: "g2" }, { id: "g1" }],
    }),
  ];
  const { canonicalJson } = canonicalizeCatalog(products);
  const parsed = JSON.parse(canonicalJson);
  assert.deepEqual(
    parsed.products[0].modifierGroups.map((g) => g.id),
    ["g2", "g1"]
  );
});

test("option array order is preserved through canonicalization (not sorted)", () => {
  const products = [
    product({
      productId: "p1",
      modifierGroups: [{ id: "g1", options: [{ id: "o2" }, { id: "o1" }] }],
    }),
  ];
  const { canonicalJson } = canonicalizeCatalog(products);
  const parsed = JSON.parse(canonicalJson);
  assert.deepEqual(
    parsed.products[0].modifierGroups[0].options.map((o) => o.id),
    ["o2", "o1"]
  );
});

test("same logical catalog state produces identical canonical bytes regardless of input key order", () => {
  const a = [{ productId: "p1", categoryOrder: 1, itemOrder: 1, name: "X", price: 100 }];
  const b = [{ price: 100, name: "X", itemOrder: 1, categoryOrder: 1, productId: "p1" }];
  const resultA = canonicalizeCatalog(a);
  const resultB = canonicalizeCatalog(b);
  assert.equal(resultA.canonicalJson, resultB.canonicalJson);
});

test("canonical payload never contains a revision field", () => {
  const products = [product()];
  const { canonicalJson } = canonicalizeCatalog(products);
  assert.equal(canonicalJson.includes("revision"), false);
});
