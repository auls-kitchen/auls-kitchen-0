const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalogPublishPlan } = require("../../src/domain/catalogPublishPlan");

function validRaw(overrides = {}) {
  return {
    id: "prod1",
    name: "Java Aren",
    price: 10000,
    category: "coffee",
    categoryLabel: "Coffee",
    categoryOrder: 1,
    itemOrder: 1,
    ...overrides,
  };
}

test("a fully valid catalog produces an ok plan with a revision", () => {
  const plan = buildCatalogPublishPlan([validRaw()]);
  assert.equal(plan.ok, true);
  assert.match(plan.revision, /^[0-9a-f]{64}$/);
  assert.equal(plan.productCount, 1);
  assert.equal(plan.products.length, 1);
});

test("one malformed product causes the ENTIRE publish to fail (D1)", () => {
  const plan = buildCatalogPublishPlan([
    validRaw({ id: "good1" }),
    validRaw({ id: "bad1", name: "" }), // fatal: missing name
    validRaw({ id: "good2" }),
  ]);
  assert.equal(plan.ok, false);
  assert.equal(plan.validationFailures.length, 1);
  assert.equal(plan.validationFailures[0].productId, "bad1");
  assert.ok(plan.validationFailures[0].errors.includes("MISSING_PRODUCT_NAME"));
  // No revision/products/canonicalJson leaks out on a failed plan.
  assert.equal("revision" in plan, false);
  assert.equal("products" in plan, false);
});

test("same logical catalog state (different doc field order) produces the same revision", () => {
  const planA = buildCatalogPublishPlan([validRaw({ id: "p1" })]);
  const planB = buildCatalogPublishPlan([
    {
      itemOrder: 1,
      categoryOrder: 1,
      categoryLabel: "Coffee",
      category: "coffee",
      price: 10000,
      name: "Java Aren",
      id: "p1",
    },
  ]);
  assert.equal(planA.ok, true);
  assert.equal(planB.ok, true);
  assert.equal(planA.revision, planB.revision);
});

test("a changed catalog (different price) produces a different revision", () => {
  const planA = buildCatalogPublishPlan([validRaw({ id: "p1", price: 10000 })]);
  const planB = buildCatalogPublishPlan([validRaw({ id: "p1", price: 12000 })]);
  assert.notEqual(planA.revision, planB.revision);
});

test("multiple valid products are sorted deterministically in the plan", () => {
  const plan = buildCatalogPublishPlan([
    validRaw({ id: "b", categoryOrder: 2, itemOrder: 1 }),
    validRaw({ id: "a", categoryOrder: 1, itemOrder: 1 }),
  ]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.products.map((p) => p.productId), ["a", "b"]);
});
