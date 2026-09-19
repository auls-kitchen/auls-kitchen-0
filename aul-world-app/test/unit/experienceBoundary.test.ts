// U1 structural authority tests (brief sections 3, 4, 16-C, 17).
//
// The guarantee "the Experience timer cannot reach the Domain" is made
// structural here: the lifecycle source files are scanned as text, and the
// scan FAILS if any of them names a Domain-destructive capability, imports
// anything outside aul-world-app/src (so no kiosk/, aul-world-runtime/,
// Firebase, or bare package), or references a wall-clock / AWR TICK /
// persistence-expiry mechanism.
//
// The scan targets every lifecycle file that exists at any unit. Later units
// (silenceTimer, customerInput, habitatPresentation, createExperienceLifecycle)
// are picked up automatically as they are added. ownershipConfirmation.ts is
// intentionally NOT listed: it is the one explicit-decision module allowed to
// name session-end events (unit U4, deferred).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importSpecifiers, scanSource, stripComments } from "./support/sourceScan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "src");

// Files that exist in U1 and MUST be scanned (their absence is a failure).
const REQUIRED_SCANNED = ["contracts.ts", "experience/interactionContext.ts", "experience/pendingTicket.ts"];

// Lifecycle files added by later units; scanned automatically once present.
const OPTIONAL_SCANNED = [
  "experience/silenceTimer.ts",
  "experience/customerInput.ts",
  "experience/habitatPresentation.ts",
  "experience/createExperienceLifecycle.ts",
];

function scan(relativePath: string) {
  const absolute = path.join(SRC_ROOT, relativePath);
  return scanSource(absolute, fs.readFileSync(absolute, "utf8"), SRC_ROOT);
}

// ============================================================
// C. Timer / lifecycle authority (structural)
// ============================================================

test("C1. every required lifecycle source file exists and is scanned", () => {
  for (const relative of REQUIRED_SCANNED) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, relative)), `missing required source file: ${relative}`);
  }
});

test("C2. lifecycle sources name no Domain-destructive capability, import nothing outside src, and use no forbidden clock", () => {
  const targets = [...REQUIRED_SCANNED, ...OPTIONAL_SCANNED.filter((r) => fs.existsSync(path.join(SRC_ROOT, r)))];
  for (const relative of targets) {
    const violations = scan(relative);
    assert.deepEqual(violations, [], `${relative} violates the Experience authority boundary: ${JSON.stringify(violations)}`);
  }
});

// The one explicit-decision module allowed to name session-end events (U4, deferred).
const EXEMPT_FROM_SCAN = ["experience/ownershipConfirmation.ts"];

test("C3. no file can join src/experience/ without being covered by the scan (or explicitly exempted)", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(SRC_ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(SRC_ROOT, "experience"));
  const covered = new Set([...REQUIRED_SCANNED, ...OPTIONAL_SCANNED, ...EXEMPT_FROM_SCAN]);
  for (const file of found) {
    assert.ok(covered.has(file), `src/${file} is not covered by the Experience authority scan; add it to the scan lists deliberately`);
  }
});

// ============================================================
// The scanner must actually detect violations (negative controls)
// ============================================================

const FAKE_FILE = path.join(SRC_ROOT, "experience", "fake.ts");

test("C4. negative control: each forbidden Domain capability is detected in code", () => {
  const capabilities = [
    "endSession",
    "requestSessionEnd",
    "clearCart",
    "removeLine",
    "retryUnknown",
    "beginCustomerSession",
    "hydrate",
    "requestAuthReset",
    "signOut",
    "purgeCustomerContext",
    "removeSubmissionAttempt",
    "INACTIVITY_TIMEOUT",
    "CUSTOMER_CANCELLED",
    "stopInteraction",
    "neutralIdle",
  ];
  for (const capability of capabilities) {
    const violations = scanSource(FAKE_FILE, `export const x = () => domain.${capability}();`, SRC_ROOT);
    assert.ok(
      violations.some((v) => v.kind === "FORBIDDEN_IDENTIFIER"),
      `scanner failed to detect ${capability}`,
    );
  }
});

test("C5. negative control: a forbidden identifier inside a STRING is still detected", () => {
  const violations = scanSource(FAKE_FILE, `const t = "CUSTOMER_COMPLETED"; export { t };`, SRC_ROOT);
  assert.ok(violations.some((v) => v.kind === "FORBIDDEN_IDENTIFIER" && v.detail === "CUSTOMER_COMPLETED"));
});

test("C6. comments may mention forbidden capabilities without being flagged", () => {
  const source = [
    "// never calls endSession() or clearCart()",
    "/* retryUnknown, beginCustomerSession and hydrate are forbidden here */",
    "export const ok = 1; // INACTIVITY_TIMEOUT is not used",
    'export const url = "http://example.test/path"; // a // inside a string is not a comment',
  ].join("\n");
  assert.deepEqual(scanSource(FAKE_FILE, source, SRC_ROOT), []);
});

test("C7. negative control: imports outside src (kiosk, AWR, firebase, bare, node:) are detected", () => {
  const specifiers = [
    "../../../kiosk/host/kioskHost.js",
    "../../../aul-world-runtime/src/events/bus.ts",
    "firebase/auth",
    "pixi.js",
    "node:fs",
    "../../outside.ts",
  ];
  for (const specifier of specifiers) {
    const violations = scanSource(FAKE_FILE, `import x from "${specifier}"; export { x };`, SRC_ROOT);
    assert.ok(
      violations.some((v) => v.kind === "FORBIDDEN_IMPORT" && v.detail === specifier),
      `scanner failed to detect import of ${specifier}`,
    );
  }
  // require() and dynamic import() forms too.
  assert.ok(scanSource(FAKE_FILE, `const k = require("../../../kiosk/x.js");`, SRC_ROOT).some((v) => v.kind === "FORBIDDEN_IMPORT"));
  assert.ok(scanSource(FAKE_FILE, `const k = import("../../../kiosk/x.js");`, SRC_ROOT).some((v) => v.kind === "FORBIDDEN_IMPORT"));
});

test("C8. imports that resolve inside src are allowed", () => {
  const source = `import type { Clock } from "../contracts.ts"; import { x } from "./interactionContext.ts"; export { x };`;
  assert.deepEqual(scanSource(FAKE_FILE, source, SRC_ROOT), []);
  assert.deepEqual(importSpecifiers(stripComments(source)).sort(), ["../contracts.ts", "./interactionContext.ts"]);
});

test("C9. negative control: wall-clock, TICK, and persistence-expiry mechanisms are detected", () => {
  const cases: Array<[string, string]> = [
    ["Date.now", "const t = Date.now();"],
    ["new Date", "const d = new Date();"],
    ["requestAnimationFrame", "requestAnimationFrame(() => {});"],
    ["TICK", 'if (e.type === "TICK") {}'],
    ["deltaMs", "const d = e.deltaMs;"],
    ["persistence expiry (MaxAgeMs)", "const a = opts.cartDraftMaxAgeMs;"],
    ["expiryOptions", "run(expiryOptions);"],
    ["writtenAt", "const w = rec.writtenAt;"],
    ["committedAt", "const c = attempt.committedAt;"],
  ];
  for (const [label, code] of cases) {
    const violations = scanSource(FAKE_FILE, code, SRC_ROOT);
    assert.ok(
      violations.some((v) => v.kind === "FORBIDDEN_CLOCK" && v.detail === label),
      `scanner failed to detect ${label}`,
    );
  }
});

// ============================================================
// U2: the exact shape of the lifecycle's dependency graph
// ============================================================

// Every lifecycle file and the ONLY relative imports it may have. The timer
// and the input adapter must know nothing of each other: the adapter sees just
// an InputSink, the timer sees just a Clock and a Scheduler.
const EXPECTED_IMPORTS: Record<string, string[]> = {
  "contracts.ts": [],
  "experience/interactionContext.ts": [],
  "experience/pendingTicket.ts": ["../contracts.ts"],
  "experience/silenceTimer.ts": ["../contracts.ts", "./interactionContext.ts"],
  "experience/customerInput.ts": ["../contracts.ts"],
  "experience/createExperienceLifecycle.ts": [
    "../contracts.ts",
    "./customerInput.ts",
    "./interactionContext.ts",
    "./pendingTicket.ts",
    "./silenceTimer.ts",
  ],
};

function codeOf(relativePath: string): string {
  return stripComments(fs.readFileSync(path.join(SRC_ROOT, relativePath), "utf8"));
}

test("C10. the lifecycle's import graph is exactly as designed (timer and input adapter are mutually unaware)", () => {
  for (const [relative, expected] of Object.entries(EXPECTED_IMPORTS)) {
    if (!fs.existsSync(path.join(SRC_ROOT, relative))) continue;
    const actual = [...new Set(importSpecifiers(codeOf(relative)))].sort();
    assert.deepEqual(actual, [...expected].sort(), `${relative} has an unexpected import set`);
  }
  // The three U2 files must all be present and constrained.
  for (const relative of ["experience/silenceTimer.ts", "experience/customerInput.ts", "experience/createExperienceLifecycle.ts"]) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, relative)), `missing ${relative}`);
  }
});

test("C11. noteCustomerInput (the wake/reset authority) is named only in the files that define, carry, or bridge it", () => {
  const holders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\bnoteCustomerInput\b/.test(stripComments(fs.readFileSync(full, "utf8")))) {
        holders.push(path.relative(SRC_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(SRC_ROOT);
  assert.deepEqual(holders.sort(), [
    "contracts.ts",
    "experience/createExperienceLifecycle.ts",
    "experience/customerInput.ts",
    "experience/silenceTimer.ts",
  ]);
});

test("C12. the monotonic clock source (performance) is read in exactly one lifecycle file", () => {
  const readers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\bperformance\b/.test(stripComments(fs.readFileSync(full, "utf8")))) {
        readers.push(path.relative(SRC_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(SRC_ROOT);
  assert.deepEqual(readers, ["experience/silenceTimer.ts"]);
});

test("C13. negative control: the import-graph and authority checks detect a violation", () => {
  // A timer that imported the input adapter would break C10.
  const tainted = `import { attachCustomerInput } from "./customerInput.ts"; import type { Clock } from "../contracts.ts";`;
  const actual = [...new Set(importSpecifiers(stripComments(tainted)))].sort();
  assert.notDeepEqual(actual, [...EXPECTED_IMPORTS["experience/silenceTimer.ts"]!].sort());
  // A clock read of performance in another file would break C12.
  assert.ok(/\bperformance\b/.test(stripComments("const t = performance.now();")));
  assert.ok(!/\bperformance\b/.test(stripComments("// performance is read elsewhere")));
});
