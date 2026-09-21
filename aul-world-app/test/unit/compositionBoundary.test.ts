// U3 structural authority tests for the Composition root and the shell.
//
// The Composition root is the ONE file allowed to hold both AWR wiring and the
// Kiosk host. These tests pin exactly how:
//   - it may name the Domain only as four members of the host port (and call
//     beginCustomerSession exactly once)
//   - it may import only AWR's allow-listed production modules, never main.ts or
//     any AWR proof/test artifact, and no Kiosk code at all
//   - no other source file (lifecycle, shell) can see a `host`
//   - the shell is held to the same no-Domain rules as the lifecycle

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importSpecifiers, scanSource, stripComments } from "./support/sourceScan.ts";
import type { ScanOptions } from "./support/sourceScan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "src");
const AWR_SRC = path.resolve(HERE, "..", "..", "..", "aul-world-runtime", "src");

const COMPOSITION = "composition/compositionRoot.ts";
// Composition files that are NOT the root: injected and pure, held to the strict scan (CB13).
const COMPOSITION_HELPERS = ["composition/contextTransitions.ts", "composition/contextBoundary.ts"];
const SHELL_FILES = ["shell/shellModel.ts", "shell/experienceShell.ts"];

// The AWR modules the Composition may import DIRECTLY (what AWR's own bootstrap
// wires, minus every proof/test artifact).
const ALLOWED_AWR_IMPORTS = [
  "behavior/reducer.ts",
  "events/bus.ts",
  "events/types.ts",
  "ordering/orderingBoundary.ts",
  "ordering/reducer.ts",
  "ordering/types.ts",
  "platform/resize.ts",
  "render/adapter/pixiRendererAdapter.ts",
  "render/renderState.ts",
  "state/initialState.ts",
  "state/types.ts",
  "world/hitTestPipeline.ts",
];

const FORBIDDEN_AWR_IMPORTS = [
  "main.ts",
  "dom/domPanel.ts",
  "render/adapter/canvas2dTestAdapter.ts",
  "ordering/orderingAlt.ts",
  "render/depthProof.ts",
  "services/mockGreetingService.ts",
  "effects/greetingEffect.ts",
];

// The composition file's explicit, narrow relaxations.
const COMPOSITION_OPTIONS: ScanOptions = {
  // The two Domain calls it makes: the boot, once, at mount; and the guarded
  // release, once, handed to the context-transitions coordinator (U4 S3).
  allowIdentifiers: ["beginCustomerSession", "releaseCustomerContext"],
  // AWR's own frame loop (never the interaction clock).
  allowClockLabels: ["requestAnimationFrame", "TICK", "deltaMs"],
  isImportAllowed: (resolved) => {
    const relative = path.relative(AWR_SRC, resolved).split(path.sep).join("/");
    return !relative.startsWith("..") && ALLOWED_AWR_IMPORTS.includes(relative);
  },
};

const read = (relative: string) => fs.readFileSync(path.join(SRC_ROOT, relative), "utf8");
const abs = (relative: string) => path.join(SRC_ROOT, relative);

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, into);
    else into.push(path.relative(SRC_ROOT, full).split(path.sep).join("/"));
  }
  return into;
}

// ============================================================
// The Composition root
// ============================================================

test("CB1. the Composition root passes its explicit, narrow rules", () => {
  const violations = scanSource(abs(COMPOSITION), read(COMPOSITION), SRC_ROOT, COMPOSITION_OPTIONS);
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("CB2. its AWR imports are exactly the allow-listed production modules (no main.ts, no proof/test artifact)", () => {
  const specifiers = [...new Set(importSpecifiers(stripComments(read(COMPOSITION))))];
  const awrImports = specifiers
    .filter((s) => s.includes("aul-world-runtime/src/"))
    .map((s) => s.replace(/^.*aul-world-runtime\/src\//, ""))
    .sort();
  assert.deepEqual(awrImports, [...ALLOWED_AWR_IMPORTS].sort());
  for (const forbidden of FORBIDDEN_AWR_IMPORTS) {
    assert.equal(awrImports.includes(forbidden), false, `${forbidden} must never be imported`);
  }
});

test("CB3. it names the Domain only as five host members, and calls beginCustomerSession and releaseCustomerContext exactly once each", () => {
  const code = stripComments(read(COMPOSITION));
  const accessed = new Set<string>();
  for (const match of code.matchAll(/\bhost\s*\.\s*([A-Za-z_]+)(?:\s*\.\s*([A-Za-z_]+))?/g)) {
    accessed.add(match[2] ? `${match[1]}.${match[2]}` : match[1]!);
  }
  assert.deepEqual(
    [...accessed].sort(),
    ["beginCustomerSession", "getBootstrapStatus", "orchestrator.getSnapshot", "orchestrator.releaseCustomerContext", "orchestrator.subscribe"],
  );
  assert.equal([...code.matchAll(/\bhost\s*\.\s*beginCustomerSession\s*\(/g)].length, 1, "beginCustomerSession must have exactly one call site");
  assert.equal(
    [...code.matchAll(/\bhost\s*\.\s*orchestrator\s*\.\s*releaseCustomerContext\s*\(/g)].length,
    1,
    "releaseCustomerContext must have exactly one call site",
  );
});

test("CB4. it imports no Kiosk code of any kind (the host arrives by injection)", () => {
  for (const specifier of importSpecifiers(stripComments(read(COMPOSITION)))) {
    assert.equal(/kiosk/i.test(specifier), false, `Kiosk import: ${specifier}`);
  }
});

// ============================================================
// Nothing else can see a host
// ============================================================

test("CB5. no lifecycle, shell or contract file mentions `host` or imports AWR or the Kiosk", () => {
  const others = walk(SRC_ROOT).filter((f) => f !== COMPOSITION);
  assert.equal(
    others.length,
    11,
    "expected exactly the 8 U0-U3 non-composition source files, U4 Slice 2A's takeoverPolicy.ts, and U4 Slice 2B's composition/contextTransitions.ts and composition/contextBoundary.ts",
  );
  for (const file of others) {
    const code = stripComments(read(file));
    assert.equal(/\bhost\b/.test(code), false, `${file} names a host`);
    for (const specifier of importSpecifiers(code)) {
      assert.equal(/kiosk|aul-world-runtime/i.test(specifier), false, `${file} imports ${specifier}`);
    }
  }
});

test("CB6. no file can join src/shell/ or src/composition/ without being scanned deliberately", () => {
  assert.deepEqual(walk(path.join(SRC_ROOT, "shell")).map((f) => `shell/${f.replace(/^shell\//, "")}`).sort(), [...SHELL_FILES].sort());
  assert.deepEqual(
    walk(path.join(SRC_ROOT, "composition")).map((f) => f.replace(/^composition\//, "composition/")).sort(),
    [COMPOSITION, ...COMPOSITION_HELPERS].sort(),
  );
});

test("CB13. every composition helper other than the root is held to the strict Experience scan (no Domain name, no clock, imports only inside src)", () => {
  for (const file of COMPOSITION_HELPERS) {
    const violations = scanSource(abs(file), read(file), SRC_ROOT);
    assert.deepEqual(violations, [], `${file}: ${JSON.stringify(violations)}`);
  }
});

// ============================================================
// The shell is held to the lifecycle's no-Domain, no-clock rules
// ============================================================

test("CB7. the shell names no Domain capability at all, imports only inside src, and uses no clock", () => {
  for (const file of SHELL_FILES) {
    const violations = scanSource(abs(file), read(file), SRC_ROOT);
    assert.deepEqual(violations, [], `${file}: ${JSON.stringify(violations)}`);
  }
});

test("CB8. the shell's only interactive controls are Menu (asks AWR for its menu) and Home/X (reports the phase before the press); neither has a Domain callback", () => {
  const code = stripComments(read("shell/experienceShell.ts"));
  assert.equal([...code.matchAll(/createElement\(\s*["']button["']\s*\)/g)].length, 2, "exactly two buttons");
  assert.deepEqual(
    [...code.matchAll(/setAttribute\(\s*["']data-shell-action["']\s*,\s*["'](\w+)["']\s*\)/g)].map((m) => m[1]).sort(),
    ["home", "menu"],
  );
  // Its whole output surface: the two callbacks the Composition supplies, and the one-shot latch it reads.
  const options = code.match(/export interface ExperienceShellOptions \{([\s\S]*?)\}/)![1]!;
  assert.deepEqual([...options.matchAll(/readonly (\w+):/g)].map((m) => m[1]).sort(), ["consumeGesture", "domainStatus", "onHome", "onMenu"]);
  // What Home hands over is a phase and nothing else.
  const model = stripComments(read("shell/shellModel.ts"));
  const request = model.match(/export interface HomeRequest \{([\s\S]*?)\}/)![1]!;
  assert.deepEqual([...request.matchAll(/readonly (\w+):/g)].map((m) => m[1]), ["phaseBefore"]);
});

test("CB12. Slice 2A: the Composition's Home boundary reads one snapshot, applies the pure policy, and records the decision - nothing else", () => {
  const code = stripComments(read(COMPOSITION));
  const start = code.indexOf("onHome: (request) => {");
  const end = code.indexOf("cleanups.push(() => shell.dispose())");
  assert.ok(start > 0 && end > start, "the onHome boundary must be found");
  const boundary = code.slice(start, end);

  assert.equal([...code.matchAll(/\bdecideTakeover\s*\(/g)].length, 1, "one call site for the policy");
  for (const required of ["snapshots.getSnapshot()", "decideTakeover(", "options.onHomeDecision?.(decision)"]) {
    assert.ok(boundary.includes(required), `the boundary must contain ${required}`);
  }
  // No Domain, no AWR bus, no shell, no routing, no world change from a Home activation.
  for (const forbidden of ["host", "bus", "shell.", "setWake", "setPhase", "routeCustomerReturn", "returnToWorld", "MENU_INTENT", "RETURN_TO_WORLD", "RESET_WORLD"]) {
    assert.equal(boundary.includes(forbidden), false, `the Home boundary must not touch ${forbidden}`);
  }
  // S3 wired a release for the 5-minute expiry only: Home/X stays release-free (takeover is a later slice).
  for (const forbidden of ["releaseCustomerContext", "transitions", "releasePlanFor"]) {
    assert.equal(boundary.includes(forbidden), false, `the Home boundary must not touch ${forbidden}`);
  }
});

// ============================================================
// U4 Slice 2B, S3: the expiry -> guarded release wiring, and nothing more
// ============================================================

const compositionCode = () => stripComments(read(COMPOSITION));
const expiryHandler = (): string => {
  const code = compositionCode();
  const start = code.indexOf("function handleContextExpired(): void {");
  const end = code.indexOf("const experience = createExperienceLifecycle(");
  assert.ok(start > 0 && end > start, "the expiry handler must be found");
  return code.slice(start, end);
};

test("CB14. S3: the Domain release is named ONCE, as the coordinator's injected function - the only release seam", () => {
  const code = compositionCode();
  assert.equal([...code.matchAll(/\breleaseCustomerContext\b/g)].length, 2, "the port type member and the one call site, nothing else");
  assert.match(code, /createContextTransitions\(\{\s*release:\s*\(\)\s*=>\s*host\.orchestrator\.releaseCustomerContext\(\),/);
  assert.equal([...code.matchAll(/\bcreateContextTransitions\s*\(/g)].length, 1, "exactly one coordinator");
});

test("CB15. S3: the expiry handler reads ONE snapshot, applies releasePlanFor, and only for RELEASE starts a release with cause EXPIRY - fire and forget", () => {
  const handler = expiryHandler();
  const read = handler.indexOf("snapshots.getSnapshot()");
  const plan = handler.indexOf('releasePlanFor(snapshot) !== "RELEASE"');
  const release = handler.indexOf('void transitions.release("EXPIRY")');
  assert.ok(read > 0 && plan > read && release > plan, "read, then plan guard, then release - in that order");
  assert.equal([...handler.matchAll(/getSnapshot\s*\(/g)].length, 1, "exactly one snapshot read");
  assert.equal([...compositionCode().matchAll(/\btransitions\s*\.\s*release\s*\(/g)].length, 1, "one release call in the whole composition");
  assert.equal([...compositionCode().matchAll(/\breleasePlanFor\s*\(/g)].length, 1, "one plan guard");
  // The verdict is neither awaited nor inspected, and nothing is presented because of it.
  for (const forbidden of ["await", ".then", ".catch", "verdict", "shell.", "setWake", "setPhase", "bus.", "onWake", "onPhase", "RESET_WORLD", "RETURN_TO_WORLD", "OBJECT_INTERACTED"]) {
    assert.equal(handler.includes(forbidden), false, `the expiry handler must not use ${forbidden}`);
  }
});

test("CB16. S3: the lifecycle gets the handler; the coordinator is created before the lifecycle and disposed AFTER it (reverse cleanup order)", () => {
  const code = compositionCode();
  const created = code.indexOf("const transitions = createContextTransitions(");
  const disposePush = code.indexOf("cleanups.push(() => transitions.dispose())");
  const lifecycleCreated = code.indexOf("const experience = createExperienceLifecycle(");
  const lifecyclePush = code.indexOf("cleanups.push(() => experience.dispose())");
  assert.ok(created > 0 && disposePush > created, "the coordinator's dispose is registered right after it is created");
  assert.ok(lifecycleCreated > disposePush, "the lifecycle is created after the coordinator's cleanup is registered");
  assert.ok(lifecyclePush > lifecycleCreated, "and its own cleanup is registered later, so it runs FIRST on dispose");
  assert.match(code, /onContextExpired:\s*handleContextExpired,/);
  assert.equal([...code.matchAll(/\bonContextExpired\s*:/g)].length, 1);
});

test("CB17. S3: nothing of S4 entered the Composition - only the three already-approved AWR events, no world reset, no takeover release, no reconcile", () => {
  const code = compositionCode();
  const emitted = [...code.matchAll(/bus\.emit\(\s*\{\s*type:\s*"(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(emitted, ["MENU_INTENT", "RETURN_TO_WORLD", "TICK"]);
  for (const forbidden of [
    "RESET_WORLD",
    "DOM_PANEL_ACTION",
    "OBJECT_INTERACTED",
    "afterSettle",
    "isSettling",
    "classifyReleaseResult",
    "WAKE_RECONCILE",
    "REBOOT_BOUNDARY",
    '"TAKEOVER"',
    "UNAVAILABLE",
    "unavailable",
  ]) {
    assert.equal(code.includes(forbidden), false, `the composition must not contain ${forbidden} yet`);
  }
});

// ============================================================
// Negative controls: the rules above actually detect violations
// ============================================================

const FAKE = abs(COMPOSITION);

test("CB9. negative control: Domain capabilities beyond the allowed ones are caught", () => {
  for (const call of ["host.orchestrator.endSession('x')", "host.orchestrator.clearCart()", "host.orchestrator.retryUnknown()", "host.orchestrator.addItem({})", "host.hydrate()", "host.requestAuthReset()"]) {
    const violations = scanSource(FAKE, `export const x = () => ${call};`, SRC_ROOT, COMPOSITION_OPTIONS);
    assert.ok(violations.some((v) => v.kind === "FORBIDDEN_IDENTIFIER"), `not caught: ${call}`);
  }
  // beginCustomerSession is the composition's one exception - and ONLY the composition's.
  assert.deepEqual(scanSource(FAKE, "export const boot = () => host.beginCustomerSession();", SRC_ROOT, COMPOSITION_OPTIONS), []);
  assert.ok(scanSource(abs("shell/experienceShell.ts"), "export const boot = () => host.beginCustomerSession();", SRC_ROOT).length > 0);
  assert.ok(scanSource(abs("experience/silenceTimer.ts"), "export const boot = () => host.beginCustomerSession();", SRC_ROOT).length > 0);
  // releaseCustomerContext is the composition's other exception - and ONLY the composition's.
  const release = "export const go = () => host.orchestrator.releaseCustomerContext();";
  assert.deepEqual(scanSource(FAKE, release, SRC_ROOT, COMPOSITION_OPTIONS), []);
  for (const file of ["shell/experienceShell.ts", "shell/shellModel.ts", "experience/silenceTimer.ts", "experience/createExperienceLifecycle.ts", "experience/takeoverPolicy.ts", "composition/contextTransitions.ts"]) {
    assert.ok(scanSource(abs(file), release, SRC_ROOT).some((v) => v.detail === "releaseCustomerContext"), `not caught in ${file}`);
  }
});

test("CB10. negative control: importing AWR's main.ts or any proof/test artifact, or any Kiosk module, is caught", () => {
  for (const forbidden of FORBIDDEN_AWR_IMPORTS) {
    const source = `import x from "../../../aul-world-runtime/src/${forbidden}"; export { x };`;
    const violations = scanSource(FAKE, source, SRC_ROOT, COMPOSITION_OPTIONS);
    assert.ok(violations.some((v) => v.kind === "FORBIDDEN_IMPORT"), `not caught: ${forbidden}`);
  }
  for (const allowed of ALLOWED_AWR_IMPORTS) {
    const source = `import x from "../../../aul-world-runtime/src/${allowed}"; export { x };`;
    assert.deepEqual(scanSource(FAKE, source, SRC_ROOT, COMPOSITION_OPTIONS), [], `wrongly rejected: ${allowed}`);
  }
  assert.ok(scanSource(FAKE, `import k from "../../../kiosk/host/kioskHost.js"; export { k };`, SRC_ROOT, COMPOSITION_OPTIONS).some((v) => v.kind === "FORBIDDEN_IMPORT"));
  assert.ok(scanSource(FAKE, `import k from "../../../kiosk/dist/createBrowserKiosk.js"; export { k };`, SRC_ROOT, COMPOSITION_OPTIONS).some((v) => v.kind === "FORBIDDEN_IMPORT"));
});

test("CB11. negative control: the composition's clock relaxations are narrow (a wall clock or expiry is still caught)", () => {
  for (const code of ["const t = Date.now();", "const d = new Date();", "const a = opts.cartDraftMaxAgeMs;", "run(expiryOptions);"]) {
    assert.ok(scanSource(FAKE, code, SRC_ROOT, COMPOSITION_OPTIONS).some((v) => v.kind === "FORBIDDEN_CLOCK"), `not caught: ${code}`);
  }
  // ...while AWR's own frame loop is allowed in the composition and nowhere else.
  const loop = `bus.emit({ type: "TICK", deltaMs }); requestAnimationFrame(tick);`;
  assert.deepEqual(scanSource(FAKE, loop, SRC_ROOT, COMPOSITION_OPTIONS), []);
  assert.ok(scanSource(abs("experience/silenceTimer.ts"), loop, SRC_ROOT).some((v) => v.kind === "FORBIDDEN_CLOCK"));
});
