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

test("CB12. S4c: the Home boundary reads one snapshot, applies the pure policy, records the decision, and now ACTS on it through the same shared machinery every other release path already uses", () => {
  const code = stripComments(read(COMPOSITION));
  const start = code.indexOf("onHome: (request) => {");
  const end = code.indexOf("cleanups.push(() => shell.dispose())");
  assert.ok(start > 0 && end > start, "the onHome boundary must be found");
  const boundary = code.slice(start, end);

  assert.equal([...code.matchAll(/\bdecideTakeover\s*\(/g)].length, 1, "one call site for the policy");
  for (const required of [
    "snapshots.getSnapshot()",
    "decideTakeover(",
    "options.onHomeDecision?.(decision)",
    "reconcileContext(",
    "presentImmediate(routeCustomerReturn(snapshot));",
  ]) {
    assert.ok(boundary.includes(required), `the boundary must contain ${required}`);
  }
  assert.equal([...boundary.matchAll(/getSnapshot\s*\(/g)].length, 1, "still exactly one snapshot read");
  assert.equal([...boundary.matchAll(/\breconcileContext\s*\(/g)].length, 1, "exactly one reconciliation call site");
  assert.match(boundary, /reconcileContext\(routeCustomerReturn\(snapshot\), snapshot, "TAKEOVER", \(plan\) => plan === "RELEASE"\);/);
  // No raw Domain/AWR/shell/release primitive INLINE here - everything goes through the shared
  // presentImmediate/reconcileContext machinery (defined once, elsewhere), never duplicated.
  for (const forbidden of [
    "host",
    "bus.",
    "shell.",
    "setWake",
    "setPhase",
    "returnToWorld",
    "MENU_INTENT",
    "RETURN_TO_WORLD",
    "RESET_WORLD",
    "releaseCustomerContext",
    "transitions.",
    "releasePlanFor",
    "afterSettle",
    "boundary.own",
    "boundary.beginEpoch",
  ]) {
    assert.equal(boundary.includes(forbidden), false, `the Home boundary must not touch ${forbidden} directly - only through reconcileContext/presentImmediate`);
  }
});

test("CB22. S4c: BLOCKED_UNKNOWN is isolated from the takeover branch - it can never reach reconcileContext, so it can never begin a new epoch or touch the Domain", () => {
  const code = compositionCode();
  const start = code.indexOf('if (decision === "BLOCKED_UNKNOWN") {');
  const mid = code.indexOf('} else if (decision === "TAKEOVER_ACTIVE_CART"');
  const end = code.indexOf("},", mid);
  assert.ok(start > 0 && mid > start && end > mid, "both decision branches must be found, in that order");
  const blockedBranch = code.slice(start, mid);
  const takeoverBranch = code.slice(mid, end);
  for (const forbidden of ["reconcileContext", "beginEpoch", "transitions.release", "resetWorld"]) {
    assert.equal(blockedBranch.includes(forbidden), false, `BLOCKED_UNKNOWN must never reach ${forbidden}`);
  }
  assert.match(blockedBranch, /presentImmediate\(routeCustomerReturn\(snapshot\)\);/);
  assert.match(takeoverBranch, /reconcileContext\(/);
  assert.match(takeoverBranch, /decision === "TAKEOVER_ACTIVE_CART" \|\| decision === "TAKEOVER_CONFIRMATION"/);
  // NOT_READY and NO_TAKEOVER fall through neither branch: no third arm exists.
  assert.equal([...code.matchAll(/\} else if \(decision ===/g)].length, 1, "exactly one else-if: no third decision branch");
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

test("CB15. S4b: the expiry handler reads ONE snapshot, applies releasePlanFor, and only for RELEASE acquires boundary ownership of the CURRENT epoch before releasing with cause EXPIRY - and a refused ownership never releases", () => {
  const handler = expiryHandler();
  const read = handler.indexOf("snapshots.getSnapshot()");
  const plan = handler.indexOf('releasePlanFor(snapshot) !== "RELEASE"');
  const own = handler.indexOf("boundary.own(");
  const release = handler.indexOf('void transitions.release("EXPIRY")');
  assert.ok(read > 0 && plan > read && own > plan && release > own, "read, then plan guard, then acquire ownership, then release - in that order");
  assert.equal([...handler.matchAll(/getSnapshot\s*\(/g)].length, 1, "exactly one snapshot read");
  assert.match(handler, /if \(!owned\) return;/, "a refused ownership attempt returns without ever calling release");
  // Three release call sites now exist in the whole file: expiry (here), and the wake/reboot
  // reconciler's fast and contested paths (reconcileContext) - every one of them guarded the
  // same way, by exactly one boundary.own() immediately before it.
  assert.equal([...compositionCode().matchAll(/\btransitions\s*\.\s*release\s*\(/g)].length, 3, "expiry + reconcileContext's two release call sites");
  assert.equal([...compositionCode().matchAll(/\bboundary\s*\.\s*own\s*\(/g)].length, 3, "one own() guarding each release call site");
  for (const forbidden of ["await", ".then", ".catch", "shell.", "setWake", "setPhase", "bus.", "onWake", "onPhase"]) {
    assert.equal(handler.includes(forbidden), false, `the expiry handler must not use ${forbidden} directly - only its owned continuation (resetWorld) may`);
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

test("CB17. S4b/S4c: RESET_WORLD/RETURN_TO_WORLD are emitted from ONE function, in that order, gated by FRESH + worldQuiet - and takeover reuses that SAME function, adding no second reset path", () => {
  const code = compositionCode();
  const emitted = [...new Set([...code.matchAll(/bus\.emit\(\s*\{\s*type:\s*"(\w+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(emitted, ["DOM_PANEL_ACTION", "MENU_INTENT", "RETURN_TO_WORLD", "TICK"]);
  // RETURN_TO_WORLD now has two legitimate source occurrences: enterHabitat's own
  // presentation.returnToWorld (unrelated to this feature, unchanged) and resetWorld's.
  assert.equal([...code.matchAll(/type:\s*"RETURN_TO_WORLD"/g)].length, 2, "enterHabitat's own returnToWorld, plus resetWorld's");
  assert.equal([...code.matchAll(/function resetWorld\(\)\s*:\s*void\s*\{/g)].length, 1, "exactly one resetWorld function");
  const start = code.indexOf("function resetWorld(): void {");
  // A fixed-size window past the opening brace: the two emit() calls each contain their
  // own object-literal "}", so the FIRST "}" in the text is not the function's own.
  const body = code.slice(start, start + 250);
  const resetAt = body.indexOf('action: "RESET_WORLD"');
  const returnAt = body.indexOf('type: "RETURN_TO_WORLD"');
  assert.ok(resetAt > 0 && returnAt > resetAt, "RESET_WORLD is emitted before RETURN_TO_WORLD, from the same function");
  // Both call sites (the expiry owner's own callback, and presentFinal for wake/reboot) use the
  // exact same gate - no reset is ever reachable any other way.
  assert.equal([...code.matchAll(/\bresetWorld\s*\(\s*\)/g)].length, 3, "the definition plus exactly two call sites");
  assert.equal(
    [...code.matchAll(/if \(verdict === "FRESH" && boundary\.worldQuiet\(token\)\) resetWorld\(\);/g)].length,
    2,
    "both reset call sites are gated by the identical FRESH + worldQuiet check",
  );
  // touch is noted from customer-caused AWR events only, and consulted only by worldQuiet -
  // it is never read by own()/isCurrent(), so it can never authorize anything.
  assert.match(code, /boundary\.noteWorldTouch\(\)/);
  assert.equal([...code.matchAll(/\bboundary\s*\.\s*noteWorldTouch\s*\(\s*\)/g)].length, 1, "noted from exactly one place: the bus subscriber");
  for (const forbidden of ["OWNERSHIP_CONFIRMATION", "data-pending", "hasPendingTicket"]) {
    assert.equal(code.includes(forbidden), false, `the composition must not contain ${forbidden}`);
  }
  // "TAKEOVER" is now legitimate (S4c) - exactly one call site, reusing resetWorld, never a
  // second reset function or a second RESET_WORLD/RETURN_TO_WORLD pair of its own.
  assert.equal([...code.matchAll(/"TAKEOVER"/g)].length, 1, "the takeover cause is named exactly once");
});

test("CB18. S4b: touch is never presentation/release authority - neither the eligibility predicates NOR reconcileContext's own eligibility guards ever consult worldQuiet", () => {
  const code = compositionCode();
  const wakeCall = code.indexOf('reconcileContext(decision, snapshot, "WAKE_RECONCILE"');
  const rebootCall = code.indexOf('reconcileContext(routeCustomerReturn(snapshot), snapshot, "REBOOT_BOUNDARY"');
  assert.ok(wakeCall > 0 && rebootCall > 0, "both reconcileContext call sites must be found");
  const wakeEligible = code.slice(wakeCall, code.indexOf(";", wakeCall));
  const rebootEligible = code.slice(rebootCall, code.indexOf(";", rebootCall));
  for (const eligible of [wakeEligible, rebootEligible]) {
    assert.equal(eligible.includes("worldQuiet"), false, `an eligibility predicate must never consult worldQuiet: ${eligible}`);
  }
  // eligible() itself is defined with exactly the (plan, snapshot) signature reconcileContext expects -
  // no third parameter through which a token/touch could sneak in.
  assert.match(code, /eligible: \(plan: ReleasePlan, snapshot: ExperienceSnapshotView \| null\) => boolean,/);
  // The two eligibility GUARDS inside reconcileContext itself (fast path setup, and the contested
  // path's re-evaluation) test eligible() alone - worldQuiet is used ONLY inside presentFinal, to
  // gate the optional reset, never to decide whether to reconcile at all.
  assert.equal([...code.matchAll(/if \(!eligible\(/g)].length, 2, "both eligibility guards");
  assert.equal(code.includes("|| !boundary.worldQuiet") || code.includes("!boundary.worldQuiet(token) ||"), false, "no eligibility guard OR's in a worldQuiet check");
  assert.equal([...code.matchAll(/\bboundary\s*\.\s*worldQuiet\s*\(/g)].length, 2, "worldQuiet is read in exactly two places - both inside presentFinal's reset gate");
});

test("CB19. S4b: reconcileContext's own() attempts never retry or loop - a refused attempt presents immediately and gives up, exactly once per call site", () => {
  const code = compositionCode();
  const ownSites = [...code.matchAll(/\bboundary\s*\.\s*own\s*\(/g)];
  assert.equal(ownSites.length, 3, "expiry + reconcileContext's fast and contested paths");
  for (const site of ownSites) {
    // A generous window around each own() call site must contain no loop construct.
    const window = code.slice(Math.max(0, site.index! - 200), site.index! + 300);
    for (const loopKeyword of [/\bwhile\s*\(/, /\bfor\s*\(/, /\.retry\b/]) {
      assert.equal(loopKeyword.test(window), false, `own() call site must not be wrapped in a retry loop: ${loopKeyword}`);
    }
  }
  // Every own() call site's boolean result is tested directly (as an if-condition, or assigned
  // and then checked once) - never ignored, and never re-attempted with the same token.
  const testedDirectly = [...code.matchAll(/if \(boundary\.own\(token,/g)].length + [...code.matchAll(/const owned = boundary\.own\(token,/g)].length;
  assert.equal(testedDirectly, 3, "every own() call site tests its own boolean result directly");
});

test("CB20. S4b: reconcileContext establishes the epoch (beginEpoch) BEFORE deriving the release plan or checking eligibility - never after", () => {
  const code = compositionCode();
  const fnStart = code.indexOf("function reconcileContext(");
  const fnBody = code.slice(fnStart, code.indexOf("\n    }\n", fnStart));
  const beginEpoch = fnBody.indexOf("boundary.beginEpoch()");
  const plan = fnBody.indexOf("releasePlanFor(snapshot)");
  const eligible = fnBody.indexOf("eligible(plan, snapshot)");
  assert.ok(beginEpoch > 0 && plan > beginEpoch && eligible > plan, "beginEpoch, then the plan, then the eligibility check - in that order");
});

test("CB21. S4b: the reboot boundary's eligibility is CONFIRMATION only - never a bare RELEASE plan, so a hypothetical ACTIVE cart is never reconciled at reboot", () => {
  const code = compositionCode();
  const rebootCall = code.indexOf('reconcileContext(routeCustomerReturn(snapshot), snapshot, "REBOOT_BOUNDARY"');
  const rebootEligible = code.slice(rebootCall, code.indexOf(";", rebootCall));
  assert.match(rebootEligible, /classifyPending\(s\) === "CONFIRMATION"/);
  assert.match(rebootEligible, /plan === "RELEASE" && classifyPending/, "RELEASE alone is not sufficient - CONFIRMATION must also hold");
});

// ============================================================
// D2 Step 1: reconcileContext's additive, optional `onFresh` continuation
// ============================================================
//
// No caller passes onFresh in this step (D2 Menu/Product wiring is NOT part of
// it), so there is no DOM/e2e path that exercises it yet. Its correctness is
// proven here in two parts that compose into the full guarantee:
//   1. structurally, that runFresh(verdict, onFresh) is reachable ONLY from
//      inside the exact same boundary.own(token, ...) closure presentFinal
//      already uses - so it inherits, for free, the at-most-once/current-
//      token-only delivery contract contextBoundary.test.ts already proves
//      exhaustively (CBD5-CBD10, CBD16) for that frozen, unmodified primitive;
//   2. behaviorally, by extracting runFresh's real body from the shipped file
//      and executing it for real, proving its OWN gating (FRESH-only, at most
//      one call, errors isolated) - the one piece contextBoundary.test.ts
//      cannot cover, since runFresh lives in compositionRoot.ts, not in the
//      frozen primitive.

test("CB23. D2 Step 1: reconcileContext gained onFresh as a 5th, OPTIONAL parameter; the three existing callers still pass exactly their original four arguments", () => {
  const code = compositionCode();
  assert.match(code, /function reconcileContext\(\s*decision: WakeDecision,\s*snapshot: ExperienceSnapshotView \| null,\s*cause: ReleaseCause,\s*eligible: \(plan: ReleasePlan, snapshot: ExperienceSnapshotView \| null\) => boolean,\s*onFresh\?: \(\) => void,\s*\): void \{/);
  // Each existing call site, verbatim, ending in `);` right after its eligible closure -
  // if a 5th argument had been added to any of them, none of these would still match.
  for (const call of [
    'reconcileContext(decision, snapshot, "WAKE_RECONCILE", (plan) => plan === "RELEASE");',
    'reconcileContext(routeCustomerReturn(snapshot), snapshot, "REBOOT_BOUNDARY", (plan, s) => plan === "RELEASE" && classifyPending(s) === "CONFIRMATION");',
    'reconcileContext(routeCustomerReturn(snapshot), snapshot, "TAKEOVER", (plan) => plan === "RELEASE");',
  ]) {
    assert.ok(code.includes(call), `existing call site must be unchanged: ${call}`);
  }
  assert.equal([...code.matchAll(/\breconcileContext\s*\(/g)].length, 4, "the definition's own reference aside, exactly three call sites");
});

test("CB24. D2 Step 1: runFresh is reachable ONLY from inside the two boundary.own(token, ...) closures presentFinal already uses, immediately after presentFinal, never inside a presentImmediate branch, and never consults worldQuiet", () => {
  const code = compositionCode();
  const runFreshCalls = [...code.matchAll(/\brunFresh\s*\(/g)];
  // One definition, two call sites - never referenced from presentImmediate's own branches.
  assert.equal([...code.matchAll(/\bfunction runFresh\s*\(/g)].length, 1);
  assert.equal(runFreshCalls.length, 3, "the definition's own name plus exactly two call sites");
  const ownSites = [...code.matchAll(/boundary\.own\(token, \(verdict\) => \{\s*presentFinal\([^)]*\);\s*runFresh\(verdict, onFresh\);\s*\}\)/g)];
  assert.equal(ownSites.length, 2, "both own() closures call presentFinal, then runFresh(verdict, onFresh), in that order - fast path and contested path");
  const fnStart = code.indexOf("function runFresh(");
  const fnEnd = code.indexOf("\n    }\n", fnStart);
  const runFreshBody = code.slice(fnStart, fnEnd);
  assert.equal(runFreshBody.includes("worldQuiet"), false, "runFresh must never consult worldQuiet - a touch may veto the reset without ever vetoing this");
  assert.equal(runFreshBody.includes("resetWorld"), false, "runFresh must never itself trigger the World reset - that stays presentFinal's job alone");
});

test("CB25. D2 Step 1 (behavioral): runFresh's real, shipped body - executed directly - runs the callback exactly once for FRESH, never for any other verdict, tolerates a missing callback, and isolates a throwing one", () => {
  const code = compositionCode();
  const fnStart = code.indexOf("function runFresh(");
  const braceStart = code.indexOf("{", fnStart);
  const fnEnd = code.indexOf("\n    }\n", fnStart);
  const body = code.slice(braceStart + 1, fnEnd);
  const runFresh = new Function("verdict", "onFresh", "report", body) as (verdict: string, onFresh: (() => void) | undefined, report: (error: unknown) => void) => void;

  let calls = 0;
  runFresh("FRESH", () => { calls += 1; }, () => assert.fail("report must not be called on success"));
  assert.equal(calls, 1, "FRESH with a callback runs it exactly once");

  calls = 0;
  runFresh("UNAVAILABLE", () => { calls += 1; }, () => assert.fail("report must not be called"));
  assert.equal(calls, 0, "a non-FRESH verdict never runs the callback");

  calls = 0;
  assert.doesNotThrow(() => runFresh("FRESH", undefined, () => assert.fail("report must not be called")));
  assert.equal(calls, 0, "no callback supplied is a silent no-op, exactly like every other optional hook here");

  const reported: unknown[] = [];
  assert.doesNotThrow(() =>
    runFresh(
      "FRESH",
      () => {
        throw new Error("boom");
      },
      (error) => reported.push(error),
    ),
  );
  assert.equal(reported.length, 1);
  assert.match(String((reported[0] as Error).message), /boom/, "a throwing continuation is caught and reported, never left to propagate");
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
