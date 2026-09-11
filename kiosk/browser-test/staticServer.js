"use strict";

/**
 * Kiosk browser verification static server (STEP 83).
 *
 * TEST INFRASTRUCTURE ONLY - not part of the Kiosk domain source, never
 * required by kiosk/browser/createBrowserKiosk.js or anything under
 * kiosk/browser/. Exists solely so Playwright can load
 * kioskHarness.html and the generated dist/ artifact over a real HTTP
 * origin (file:// cannot satisfy a browser's ES module `import`, which
 * is blocked by CORS on the file: protocol).
 *
 * Uses ONLY Node built-ins (http, fs, path) - no new npm dependency was
 * added for this (STEP 82's own recommendation, adopted here instead of
 * adding http-server/serve).
 *
 * Serves ONLY two allowed subtrees of kiosk/ - "browser-test" (the
 * harness page itself) and "dist" (the STEP 81 generated artifact) -
 * nothing else in the repository is reachable through this server.
 * Binds to 127.0.0.1 only, never 0.0.0.0, and is meant to live for
 * exactly the duration of one Playwright test run.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const KIOSK_ROOT = path.resolve(__dirname, "..");
const ALLOWED_SUBDIRS = ["browser-test", "dist"];

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * Resolves a request path to an absolute file path, refusing anything
 * that would escape KIOSK_ROOT or the two allowed subdirectories -
 * this is the sole path-traversal guard.
 *
 * @returns {string|null} the safe absolute path, or null if disallowed
 */
function resolveSafePath(requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const candidate = path.normalize(path.join(KIOSK_ROOT, decoded));

  if (!candidate.startsWith(KIOSK_ROOT + path.sep)) {
    return null; // escaped KIOSK_ROOT entirely
  }
  const withinRoot = candidate.slice(KIOSK_ROOT.length + 1);
  const topLevelDir = withinRoot.split(path.sep)[0];
  if (!ALLOWED_SUBDIRS.includes(topLevelDir)) {
    return null; // outside the two allowed subtrees
  }
  return candidate;
}

/**
 * @param {Object} [options]
 * @param {number} [options.port] - defaults to an OS-assigned free port
 * @returns {Promise<{server: import("http").Server, port: number, close: () => Promise<void>}>}
 */
function startStaticServer(options) {
  const safeOptions = options || {};
  const requestedPort = safeOptions.port || 0;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/") {
        // Convenience redirect only - the harness is always addressed
        // by its real path so relative imports inside it resolve
        // correctly (see kioskHarness.html's own ../dist/ import).
        res.writeHead(302, { Location: "/browser-test/kioskHarness.html" });
        res.end();
        return;
      }

      if (req.url === "/favicon.ico") {
        // Browsers request this unconditionally; answering 204 (rather
        // than falling through to the 404 below) avoids a benign
        // "Failed to load resource" console error that would otherwise
        // be indistinguishable from a real page error to this harness's
        // deliberately strict error listeners.
        res.writeHead(204);
        res.end();
        return;
      }

      const safePath = resolveSafePath(req.url || "/");
      if (!safePath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      fs.readFile(safePath, (error, data) => {
        if (error) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        const ext = path.extname(safePath);
        const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      });
    });

    server.on("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

module.exports = { startStaticServer, KIOSK_ROOT, ALLOWED_SUBDIRS };

// Allow running directly: `node browser-test/staticServer.js [port]`
// (used by Playwright's webServer.command).
if (require.main === module) {
  const port = Number(process.argv[2]) || 4173;
  startStaticServer({ port }).then(({ port: boundPort }) => {
    // eslint-disable-next-line no-console
    console.log("Kiosk browser-test static server listening on http://127.0.0.1:" + boundPort);
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Kiosk browser-test static server failed to start:", error.message);
    process.exit(1);
  });
}
