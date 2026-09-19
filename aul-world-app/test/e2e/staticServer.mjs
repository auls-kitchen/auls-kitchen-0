// Static server for the e2e harness (test infrastructure only). Node built-ins
// only; serves ONLY dist/e2e/; binds 127.0.0.1 explicitly (never 0.0.0.0, and
// never "localhost", which can resolve to IPv6 while Playwright polls 127.0.0.1).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "e2e");
const PORT = Number(process.argv[2] || 4174);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function resolveSafe(requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const candidate = path.normalize(path.join(ROOT, decoded === "/" ? "harness.html" : decoded));
  return candidate.startsWith(ROOT + path.sep) ? candidate : null;
}

http
  .createServer((req, res) => {
    const file = resolveSafe(req.url || "/");
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`e2e static server on http://127.0.0.1:${PORT}/`));
