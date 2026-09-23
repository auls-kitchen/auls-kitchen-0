// U4 Slice 2B, S4a: tests for src/composition/contextBoundary.ts - the pure generation guard.
//
// The invariant under test, in one sentence: work started for customer A, when it finishes
// after customer B's context has begun, can NEVER change anything B can see, and B can never
// receive A's outcome. The generation (epoch) is the only authority; touch is secondary.
// The module is generic over the outcome and pure, so none of this needs a Domain, an AWR
// bus, a shell or a clock - and the structural tests below prove it names none of them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContextBoundary } from "../../src/composition/contextBoundary.ts";
import type { BoundaryToken } from "../../src/composition/contextBoundary.ts";
import { scanSource, stripComments } from "./support/sourceScan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "src");
const FILE = "composition/contextBoundary.ts";
const source = () => fs.readFileSync(path.join(SRC_ROOT, FILE), "utf8");

// ============================================================
// Epochs and tokens
// ============================================================

test("CBD1. beginEpoch advances the epoch each time and returns a frozen token for it", () => {
  const boundary = createContextBoundary();
  const a = boundary.beginEpoch();
  const b = boundary.beginEpoch();
  const c = boundary.beginEpoch();
  assert.deepEqual([a.gen, b.gen, c.gen], [1, 2, 3]);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(b) && Object.isFrozen(c));
  assert.notEqual(a, b);
});

test("CBD2. only the token of the CURRENT epoch is current; an older token can never become current again", () => {
  const boundary = createContextBoundary();
  const a = boundary.beginEpoch();
  assert.equal(boundary.isCurrent(a), true);
  const b = boundary.beginEpoch();
  assert.equal(boundary.isCurrent(a), false, "A is stale as soon as B begins");
  assert.equal(boundary.isCurrent(b), true);
  for (let i = 0; i < 50; i++) boundary.beginEpoch();
  assert.equal(boundary.isCurrent(a), false);
  assert.equal(boundary.isCurrent(b), false);
});

test("CBD3. tokens are opaque: forged, malformed, foreign and hostile tokens are never current, never quiet, and can never own", () => {
  const boundary = createContextBoundary();
  const real = boundary.beginEpoch();
  const foreign = createContextBoundary().beginEpoch(); // gen 1 as well, but issued by someone else
  const hostile = {
    get gen(): number {
      throw new Error("hostile getter");
    },
    touch: 0,
  };
  const junk: unknown[] = [
    null,
    undefined,
    {},
    [],
    "1",
    1,
    true,
    { gen: real.gen, touch: real.touch }, // a hand-made copy of the CURRENT token's numbers
    Object.freeze({ gen: real.gen, touch: real.touch }),
    { gen: "1", touch: 0 },
    { gen: NaN, touch: 0 },
    { gen: Infinity, touch: 0 },
    foreign,
    hostile,
  ];
  junk.forEach((token, index) => {
    // (Labelled by index: formatting the hostile object itself would run its throwing getter.)
    assert.equal(boundary.isCurrent(token as BoundaryToken), false, `junk[${index}]`);
    assert.equal(boundary.worldQuiet(token as BoundaryToken), false, `junk[${index}]`);
    assert.equal(boundary.own(token as BoundaryToken, () => assert.fail("a forged token owned the slot")), false, `junk[${index}]`);
  });
  assert.equal(boundary.isCurrent(real), true, "the real token is unaffected by all of that");
});

test("CBD4. two boundaries share nothing: no module-level state", () => {
  const one = createContextBoundary();
  for (let i = 0; i < 10; i++) one.beginEpoch();
  one.noteWorldTouch();
  const two = createContextBoundary();
  const token = two.beginEpoch();
  assert.equal(token.gen, 1);
  assert.equal(token.touch, 0);
});

// ============================================================
// The invariant: a late A never mutates B
// ============================================================

test("CBD5. A starts work, B's context begins, A settles: A's continuation is REJECTED, and B then gets only its own outcome", () => {
  const boundary = createContextBoundary<string>();
  const ran: string[] = [];

  const a = boundary.beginEpoch(); // customer A's context
  assert.equal(boundary.own(a, (outcome) => ran.push(`A:${outcome}`)), true);

  const b = boundary.beginEpoch(); // customer B arrives before A's work finishes
  boundary.settle("A-outcome"); // A's work finishes late
  assert.deepEqual(ran, [], "A's continuation must not run once B's context has begun");

  assert.equal(boundary.own(b, (outcome) => ran.push(`B:${outcome}`)), true, "the slot was emptied by A's settlement");
  boundary.settle("B-outcome");
  assert.deepEqual(ran, ["B:B-outcome"], "B received exactly its own outcome, never A's");
});

test("CBD6. B cannot take over the slot while A's work is in flight, so B can never be handed A's outcome", () => {
  const boundary = createContextBoundary<string>();
  const seen: string[] = [];
  const a = boundary.beginEpoch();
  boundary.own(a, (outcome) => seen.push(`A:${outcome}`));

  const b = boundary.beginEpoch();
  assert.equal(
    boundary.own(b, (outcome) => seen.push(`B:${outcome}`)),
    false,
    "the slot belongs to the work in flight; B must wait for its completion",
  );

  boundary.settle("from-A");
  assert.deepEqual(seen, [], "neither A (stale) nor B (never registered) received A's outcome");
});

test("CBD7. the current owner receives its outcome exactly once, unchanged; a second settlement delivers nothing", () => {
  const boundary = createContextBoundary<{ readonly n: number } | undefined>();
  const received: unknown[] = [];
  boundary.own(boundary.beginEpoch(), (outcome) => received.push(outcome));

  const outcome = { n: 7 };
  boundary.settle(outcome);
  boundary.settle(outcome);
  boundary.settle(undefined);
  assert.equal(received.length, 1);
  assert.equal(received[0], outcome, "passed through by identity");

  boundary.own(boundary.beginEpoch(), (o) => received.push(o));
  boundary.settle(undefined);
  assert.equal(received.length, 2);
  assert.equal(received[1], undefined);
});

test("CBD8. settling with nothing in flight delivers nothing and changes nothing", () => {
  const boundary = createContextBoundary<string>();
  const token = boundary.beginEpoch();
  assert.doesNotThrow(() => boundary.settle("nobody"));
  assert.equal(boundary.isCurrent(token), true);
  assert.equal(boundary.own(token, () => {}), true, "the slot is still free");
});

test("CBD9. own refuses (and registers nothing) for a stale token, for a second owner, and for a non-function", () => {
  const boundary = createContextBoundary<string>();
  const stale = boundary.beginEpoch();
  const current = boundary.beginEpoch();
  assert.equal(boundary.own(stale, () => assert.fail("stale token owned")), false);

  const ran: string[] = [];
  assert.equal(boundary.own(current, (o) => ran.push(`first:${o}`)), true);
  assert.equal(boundary.own(current, (o) => ran.push(`second:${o}`)), false, "one flight, one owner");
  boundary.settle("x");
  assert.deepEqual(ran, ["first:x"], "the refused second owner was never registered");

  assert.throws(() => boundary.own(current, "not a function" as never), TypeError);
});

test("CBD10. the slot is emptied BEFORE the owner runs: a throwing or re-entrant owner cannot wedge or double-deliver", () => {
  const boundary = createContextBoundary<string>();
  const ran: string[] = [];

  boundary.own(boundary.beginEpoch(), () => {
    throw new Error("owner failed");
  });
  assert.throws(() => boundary.settle("first"), /owner failed/);
  assert.equal(boundary.own(boundary.beginEpoch(), (o) => ran.push(o)), true, "not wedged by the throwing owner");
  boundary.settle("second");
  assert.deepEqual(ran, ["second"]);

  // Re-entrancy: the owner registers the NEXT flight and settles again from inside its own run.
  const token = boundary.beginEpoch();
  boundary.own(token, (o) => {
    ran.push(`outer:${o}`);
    assert.equal(boundary.own(token, (inner) => ran.push(`inner:${inner}`)), true, "the slot was already free");
    boundary.settle("re-entrant"); // delivers to the inner owner, once
  });
  boundary.settle("go");
  assert.deepEqual(ran, ["second", "outer:go", "inner:re-entrant"]);
});

// ============================================================
// Dispose
// ============================================================

test("CBD11. dispose drops the pending continuation: a late outcome after dispose is discarded", () => {
  const boundary = createContextBoundary<string>();
  const token = boundary.beginEpoch();
  boundary.own(token, () => assert.fail("a disposed boundary delivered an outcome"));
  boundary.dispose();
  assert.doesNotThrow(() => boundary.settle("late"));
});

test("CBD12. after dispose nothing is authorized, ever: no token is current or quiet, nothing can own, a new epoch revives nothing", () => {
  const boundary = createContextBoundary<string>();
  const before = boundary.beginEpoch();
  boundary.dispose();
  assert.equal(boundary.isCurrent(before), false);
  assert.equal(boundary.worldQuiet(before), false);
  assert.equal(boundary.own(before, () => assert.fail("owned after dispose")), false);

  const after = boundary.beginEpoch();
  assert.equal(boundary.isCurrent(after), false, "beginEpoch after dispose does not revive authority");
  assert.equal(boundary.worldQuiet(after), false);
  assert.equal(boundary.own(after, () => assert.fail("owned after dispose")), false);
  assert.doesNotThrow(() => boundary.dispose(), "dispose is idempotent");
  assert.doesNotThrow(() => boundary.noteWorldTouch());
});

// ============================================================
// Touch is secondary: it never authorizes and never revokes
// ============================================================

test("CBD13. touch only vetoes an optional effect: worldQuiet flips on a touch, but isCurrent and delivery ignore it entirely", () => {
  const boundary = createContextBoundary<string>();
  const ran: string[] = [];
  const token = boundary.beginEpoch();
  assert.equal(boundary.worldQuiet(token), true);
  boundary.own(token, (o) => ran.push(o));

  boundary.noteWorldTouch();
  assert.equal(boundary.worldQuiet(token), false, "a touch since the token was issued vetoes the optional effect");
  assert.equal(boundary.isCurrent(token), true, "...but it never revokes the epoch's authority");
  boundary.settle("still-delivered");
  assert.deepEqual(ran, ["still-delivered"]);
});

test("CBD14. touch never authorizes: a quiet STALE token is still stale, and touches never advance the epoch", () => {
  const boundary = createContextBoundary<string>();
  const stale = boundary.beginEpoch();
  const current = boundary.beginEpoch();
  assert.equal(boundary.worldQuiet(stale), true, "no touch yet: the stale token is quiet");
  assert.equal(boundary.isCurrent(stale), false, "quiet is not authority");

  const ran: string[] = [];
  boundary.own(current, (o) => ran.push(o));
  for (let i = 0; i < 5; i++) boundary.noteWorldTouch();
  assert.equal(boundary.isCurrent(current), true, "five touches did not change the epoch");
  assert.equal(current.gen, boundary.beginEpoch().gen - 1);
});

test("CBD15. a new epoch's token is quiet at issue even after earlier touches: a touch only vetoes what started before it", () => {
  const boundary = createContextBoundary();
  const first = boundary.beginEpoch();
  boundary.noteWorldTouch();
  boundary.noteWorldTouch();
  assert.equal(boundary.worldQuiet(first), false);
  const second = boundary.beginEpoch();
  assert.equal(boundary.worldQuiet(second), true);
  boundary.noteWorldTouch();
  assert.equal(boundary.worldQuiet(second), false);
});

// ============================================================
// The invariant, exhaustively: model-based test over random interleavings
// ============================================================

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("CBD16. over thousands of random interleavings, an outcome reaches an owner if and only if its epoch is still the current one - exactly once, never after dispose", () => {
  let deliveries = 0;
  let stale = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const rand = lcg(seed);
    const boundary = createContextBoundary<number>();
    const issued: Array<{ token: BoundaryToken; gen: number; touch: number }> = [];
    const model = { gen: 0, touch: 0, ownerGen: null as number | null, ownerId: 0, disposed: false };
    const delivered: Array<{ owner: number; outcome: number }> = [];
    let ids = 0;
    let outcomes = 0;

    for (let step = 0; step < 40; step++) {
      const pick = Math.floor(rand() * 20);
      if (pick < 4) {
        const token = boundary.beginEpoch();
        model.gen += 1;
        issued.push({ token, gen: model.gen, touch: model.touch });
      } else if (pick < 9 && issued.length > 0) {
        const entry = issued[Math.floor(rand() * issued.length)]!;
        const owner = ids + 1;
        const expected = !model.disposed && model.ownerGen === null && entry.gen === model.gen;
        const accepted = boundary.own(entry.token, (outcome) => delivered.push({ owner, outcome }));
        assert.equal(accepted, expected, `seed ${seed} step ${step}: own`);
        if (accepted) {
          ids += 1;
          model.ownerGen = entry.gen;
          model.ownerId = owner;
        }
      } else if (pick < 14) {
        outcomes += 1;
        const before = delivered.length;
        boundary.settle(outcomes);
        const expected = !model.disposed && model.ownerGen !== null && model.ownerGen === model.gen;
        if (expected) {
          assert.equal(delivered.length, before + 1, `seed ${seed} step ${step}: a current owner must receive its outcome`);
          assert.deepEqual(delivered[delivered.length - 1], { owner: model.ownerId, outcome: outcomes }, "to the right owner, with the right outcome");
          deliveries += 1;
        } else {
          assert.equal(delivered.length, before, `seed ${seed} step ${step}: nothing may be delivered (stale, empty or disposed)`);
          if (model.ownerGen !== null) stale += 1;
        }
        model.ownerGen = null;
      } else if (pick < 16) {
        boundary.noteWorldTouch();
        model.touch += 1;
      } else if (pick < 17) {
        boundary.dispose();
        model.disposed = true;
        model.ownerGen = null;
      } else if (issued.length > 0) {
        const entry = issued[Math.floor(rand() * issued.length)]!;
        assert.equal(boundary.isCurrent(entry.token), !model.disposed && entry.gen === model.gen, `seed ${seed} step ${step}: isCurrent`);
        assert.equal(boundary.worldQuiet(entry.token), !model.disposed && entry.touch === model.touch, `seed ${seed} step ${step}: worldQuiet`);
      }
    }
  }
  // Both sides of the invariant were genuinely exercised, not vacuously true.
  assert.ok(deliveries > 300, `only ${deliveries} deliveries were exercised`);
  assert.ok(stale > 100, `only ${stale} stale settlements were exercised`);
});

// ============================================================
// Structure: pure, and it names no business vocabulary
// ============================================================

test("CBD17. the module imports nothing at all, and uses no async, timer, clock, DOM or network", () => {
  const code = stripComments(source());
  assert.equal(/^\s*import\b/m.test(code), false, "no import of any kind");
  assert.equal(/\brequire\s*\(/.test(code), false);
  for (const banned of [/\bPromise\b/, /\basync\b/, /\bawait\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bqueueMicrotask\b/, /\bdocument\b/, /\bwindow\b/, /\bfetch\b/, /\bDate\b/, /\bperformance\b/, /\bMath\.random\b/]) {
    assert.equal(banned.test(code), false, String(banned));
  }
});

test("CBD18. no business, Domain, AWR or shell vocabulary appears anywhere in its code (it is generic over the outcome)", () => {
  const code = stripComments(source());
  // Words, in any case. (The TypeScript type `unknown` is deliberately not here: it is the
  // language keyword, not the business state, which is checked in upper case below.)
  const words = /\b(session|cart|order|orders|snapshot|release\w*|verdict|hydrat\w*|kiosk|orchestrator|submission|idempotency|persist\w*|ownerUid|confirmation|awaiting|shell|bus)\b/i;
  // Constants, exactly as the Domain, the router and AWR spell them.
  const constants = /\b(UNKNOWN|AWAITING_OUTCOME|FRESH|UNAVAILABLE|NOT_READY|PROTECTED|AWR|RESET_WORLD|RETURN_TO_WORLD|DOM_PANEL_ACTION|OWNERSHIP_CONFIRMATION)\b/;
  const hit = code.match(words) ?? code.match(constants);
  assert.equal(hit, null, `business vocabulary in contextBoundary.ts: ${hit?.[0]}`);
  // The strict Experience scan (no Domain capability, no clock, no outside import) agrees.
  assert.deepEqual(scanSource(path.join(SRC_ROOT, FILE), source(), SRC_ROOT), []);
});

test("CBD19. negative control: the vocabulary scan and the strict scan would both catch a leak", () => {
  const leaky = `${source()}\nexport const leak = (host: { orchestrator: { releaseCustomerContext(): void } }) => host.orchestrator.releaseCustomerContext();\nexport const t = Date.now();\n`;
  assert.ok(scanSource(path.join(SRC_ROOT, FILE), leaky, SRC_ROOT).length >= 2);
  assert.ok(/\b(release\w*|orchestrator)\b/i.test(stripComments(leaky)));
  // ...and the uppercase-constant check catches a leaked verdict or route name.
  assert.ok(/\b(FRESH|UNKNOWN|RESET_WORLD)\b/.test(stripComments(`${source()}\nexport const v = "FRESH";`)));
});

test("CBD20. its whole public surface is exactly the guard: one factory, the token and boundary types", () => {
  const code = stripComments(source());
  assert.deepEqual([...code.matchAll(/^export (?:function|interface|const|type|class) (\w+)/gm)].map((m) => m[1]).sort(), [
    "BoundaryToken",
    "ContextBoundary",
    "createContextBoundary",
  ]);
  const surface = createContextBoundary();
  assert.deepEqual(Object.keys(surface).sort(), ["beginEpoch", "dispose", "isCurrent", "noteWorldTouch", "own", "settle", "worldQuiet"]);
  assert.ok(Object.isFrozen(surface));
});
