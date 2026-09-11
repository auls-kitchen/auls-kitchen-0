"use strict";

/**
 * Kiosk browser artifact verification - Playwright config (STEP 83).
 *
 * Fully isolated from aul-world-runtime/playwright.config.ts: this file
 * lives entirely inside kiosk/, uses kiosk/'s own @playwright/test
 * devDependency (never AWR's), and never imports or references
 * anything under aul-world-runtime/. The general `webServer` +
 * Chromium-only shape mirrors AWR's own config only as prior,
 * already-proven-in-this-repo precedent - no file or config value is
 * shared or reused.
 *
 * Scope: verifies ONLY that the STEP 81 generated artifact
 * (kiosk/dist/createBrowserKiosk.js) loads and executes in a real
 * browser engine, and that createBrowserKiosk() constructs correctly
 * against deterministic fake Firebase dependencies. It never touches
 * real Firebase, real IndexedDB, or beginCustomerSession() - see
 * kioskHarness.html and kioskHarness.browser.spec.js.
 *
 * The static server (staticServer.js) serves ONLY kiosk/browser-test/
 * and kiosk/dist/, bound to 127.0.0.1 only.
 */

const { defineConfig, devices } = require("@playwright/test");

const PORT = 4173;
const BASE_URL = "http://127.0.0.1:" + PORT + "/";

module.exports = defineConfig({
  testDir: "browser-test",
  testMatch: "**/*.browser.spec.js",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
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
    command: "node browser-test/staticServer.js " + PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
