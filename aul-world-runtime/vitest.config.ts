import { defineConfig } from "vitest/config";

// C6 Phase 1: minimum infrastructure only. Scopes Vitest to the
// unit-test directory and a plain Node environment (Layer A tests are
// pure functions — no DOM/canvas involved) — no coverage, no aliases,
// no mocks, no production module replacement.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
