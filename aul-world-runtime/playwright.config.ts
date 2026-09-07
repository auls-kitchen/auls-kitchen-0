import { defineConfig, devices } from "@playwright/test";

// C6 Phase 1: minimum infrastructure only. Runs the EXISTING production
// build (`vite preview`, not `vite dev`) so E2E tests exercise the same
// artifact the Pages workflow deploys — matching every prior AWR-04/05/
// C5 manual gate's own tooling choice. vite.config.ts's existing
// base: "/auls-kitchen-0/" is not modified; it is instead reflected here
// via baseURL. Chromium only (the only browser ever used or validated
// across every prior gate) via the sandbox's pre-installed browser, to
// avoid any browser download. No screenshot/visual comparison, no
// performance thresholds, no retry policy that would mask failures.
const PORT = 4321;
const BASE_PATH = "/auls-kitchen-0/";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: "/opt/pw-browsers/chromium",
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
