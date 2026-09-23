const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRevision } = require("../../src/domain/catalogRevision");
const crypto = require("node:crypto");

test("revision is a deterministic SHA-256 hex digest of the input", () => {
  const input = '{"products":[]}';
  const expected = crypto.createHash("sha256").update(input, "utf8").digest("hex");
  assert.equal(computeRevision(input), expected);
});

test("revision is stable across repeated calls with the same input", () => {
  const input = '{"products":[{"productId":"p1"}]}';
  assert.equal(computeRevision(input), computeRevision(input));
});

test("different canonical input produces a different revision", () => {
  const revisionA = computeRevision('{"products":[{"productId":"p1"}]}');
  const revisionB = computeRevision('{"products":[{"productId":"p2"}]}');
  assert.notEqual(revisionA, revisionB);
});

test("revision is a 64-character lowercase hex string", () => {
  const revision = computeRevision('{"products":[]}');
  assert.match(revision, /^[0-9a-f]{64}$/);
});
