// Browser e2e for the Composition root (U3). Chromium only, no retries (a retry
// would mask exactly the flakiness these tests exist to expose), one worker.
// The harness page is built by `npm run build:e2e` and served from
// dist/e2e/ on 127.0.0.1 only. Fully isolated from aul-world-runtime/ and
// kiosk/ configs: nothing here is shared with them.

import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, viewport: { width: 1280, height: 800 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build:e2e && node test/e2e/staticServer.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
