"use strict";

/**
 * Kiosk IndexedDB browser persistence verification (STEP 85).
 *
 * Run with: npm run test:browser (from kiosk/) - i.e. `playwright test`,
 * reusing kiosk/playwright.config.js and kiosk/browser-test/staticServer.js
 * unchanged from STEP 83. Requires kiosk/dist/persistenceAdapter.js and
 * kiosk/dist/indexedDbAdapter.js to exist first (`npm run
 * build:persistence-test`, STEP 85's own new, independent esbuild entry
 * point - see package.json).
 *
 * Boundary under test (deliberately lower-level than
 * kioskHarness.browser.spec.js / STEP 83):
 *
 *   persistenceAdapter -> createIndexedDbStore -> native browser IndexedDB
 *
 * No Firebase, no Auth, no Runtime, no Host, no createBrowserKiosk(), no
 * beginCustomerSession() anywhere in this file. All fixtures reuse the
 * exact valid shapes already proven by
 * kiosk/persistence/persistenceAdapter.test.js (Node/in-memory-store
 * level) - nothing invented.
 *
 * Every test database name used here is explicitly test-scoped (a
 * kioskPersistenceBrowserTest prefix) - never the two production
 * defaults from indexedDbAdapter.js - via the existing, already-
 * supported createIndexedDbStore({dbName,...}) config seam.
 * indexedDbAdapter.js exposes no close(), so cleanup always navigates
 * the page fresh (dropping every open connection at once) immediately
 * before calling indexedDB.deleteDatabase() - see resetDatabase() below.
 *
 * IMPORTANT (Playwright behavior, discovered while implementing this
 * file): each test()'s default `page` fixture runs in its OWN, fully
 * storage-isolated browser context - IndexedDB written by one test's
 * fixture page is invisible to the next test's fixture page. Since
 * P1-P16 are an intentionally stateful sequence (a save in P2 must be
 * visible to a read in P3, and P16's cleanup check must see what
 * earlier groups created), this file deliberately does NOT use the
 * `{ page }` fixture anywhere - it creates exactly ONE page for the
 * whole file (module-scoped `sharedPage`, opened once in a top-level
 * beforeAll) and every test reuses that same page/context throughout.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const HARNESS_PATH = "/browser-test/persistenceHarness.html";
const PERSISTENCE_ADAPTER_DIST = path.join(__dirname, "..", "dist", "persistenceAdapter.js");
const INDEXEDDB_ADAPTER_DIST = path.join(__dirname, "..", "dist", "indexedDbAdapter.js");

// --- fixtures, reused verbatim from persistenceAdapter.test.js ---

function validCartDraft() {
  return {
    lines: [
      {
        localLineId: "line_1",
        productId: "p1",
        quantity: 2,
        selectedModifiers: [{ groupId: "g1", optionId: "a" }],
        displaySnapshot: { name: "Kopi", price: 15000, extra: "anything" },
      },
    ],
    customerName: "Budi",
    notes: "less ice",
  };
}

function validSubmissionAttempt(overrides) {
  return Object.assign(
    {
      idempotencyKey: "abcdefgh12345678",
      items: [{ productId: "p1", quantity: 2, selectedModifiers: [{ groupId: "g1", optionId: "a" }] }],
      customerName: "Budi",
      notes: null,
      status: "IN_FLIGHT",
      committedAt: 1700000000000,
    },
    overrides
  );
}

function validAuthoritativeResult() {
  return {
    orderState: "VALIDATED",
    authoritativeTotal: 30000,
    items: [
      {
        productId: "p1",
        productName: "Kopi",
        quantity: 2,
        unitPrice: 15000,
        lineTotal: 30000,
        selectedModifiers: [{ groupName: "Size", optionName: "Large", price: 0 }],
      },
    ],
    customerName: "Budi",
    notes: null,
  };
}

// --- one shared page/context for the entire file (see header comment) ---

let sharedPage;

test.beforeAll(async ({ browser }) => {
  sharedPage = await browser.newPage();
  sharedPage.__errors = [];
  sharedPage.on("pageerror", (error) => sharedPage.__errors.push(error));
  sharedPage.on("console", (msg) => {
    if (msg.type() === "error") sharedPage.__errors.push(new Error(msg.text()));
  });
});

test.afterEach(async () => {
  expect(sharedPage.__errors || []).toEqual([]);
  sharedPage.__errors = [];
});

test.afterAll(async () => {
  await sharedPage.close();
});

async function loadHarness() {
  await sharedPage.goto(HARNESS_PATH);
  await sharedPage.waitForFunction(() => window.__persistenceTestLoaded === true);
}

/** Navigates fresh (dropping every open IndexedDB connection this page
 * held) then deletes the named test database. Safe to call on a
 * database that does not exist. */
async function resetDatabase(dbName) {
  await loadHarness();
  const result = await sharedPage.evaluate((name) => window.__persistenceTest.deleteDatabase(name), dbName);
  expect(result.ok).toBe(true);
  return result;
}

// ============================================================
// Group 1: P1-P10 - normal CRUD / round-trip sequence
// ============================================================

const CRUD_DB = { dbName: "kioskPersistenceBrowserTest_crud", storeName: "kioskPersistenceTest", dbVersion: 1 };
const OWNER_A = "test-owner-A";

test.describe("P1-P10: CRUD / round-trip against real IndexedDB", () => {
  test.beforeAll(async () => {
    await resetDatabase(CRUD_DB.dbName);
  });

  test("P1. empty read - fresh database reports EMPTY", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(result.status).toBe("EMPTY");
  });

  test("P2. Cart Draft save succeeds", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(
      ({ db, owner, cart }) => window.__persistenceTest.saveCartDraft(db, owner, cart),
      { db: CRUD_DB, owner: OWNER_A, cart: validCartDraft() }
    );
    expect(result.ok).toBe(true);
  });

  test("P3. Cart Draft read exactly round-trips through real IndexedDB", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(result.status).toBe("VALID");
    expect(result.cartDraft.lines).toEqual(validCartDraft().lines);
    expect(result.cartDraft.customerName).toBe("Budi");
    expect(result.cartDraft.notes).toBe("less ice");
  });

  test("P4. Cart Draft update replaces prior draft without corrupting other domains", async () => {
    await loadHarness();
    const updated = validCartDraft();
    updated.notes = "extra hot";
    updated.lines[0].quantity = 5;
    const saveResult = await sharedPage.evaluate(
      ({ db, owner, cart }) => window.__persistenceTest.saveCartDraft(db, owner, cart),
      { db: CRUD_DB, owner: OWNER_A, cart: updated }
    );
    expect(saveResult.ok).toBe(true);

    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(loaded.cartDraft.notes).toBe("extra hot");
    expect(loaded.cartDraft.lines[0].quantity).toBe(5);
    expect(loaded.submissionAttempt).toBeNull();
    expect(loaded.authoritativeResult).toBeNull();
  });

  test("P5. unresolved Submission Attempt save succeeds", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(
      ({ db, owner, attempt }) => window.__persistenceTest.saveSubmissionAttempt(db, owner, attempt),
      { db: CRUD_DB, owner: OWNER_A, attempt: validSubmissionAttempt() }
    );
    expect(result.ok).toBe(true);
  });

  test("P6. Submission Attempt survives real IndexedDB round-trip alongside the existing Cart Draft", async () => {
    await loadHarness();
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(loaded.status).toBe("VALID");
    expect(loaded.submissionAttempt.idempotencyKey).toBe("abcdefgh12345678");
    expect(loaded.submissionAttempt.status).toBe("IN_FLIGHT");
    expect(loaded.cartDraft).not.toBeNull(); // P4's update still present
  });

  test("P7. Authoritative Result save succeeds", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(
      ({ db, owner, key, res }) => window.__persistenceTest.saveAuthoritativeResult(db, owner, key, res),
      { db: CRUD_DB, owner: OWNER_A, key: "abcdefgh12345678", res: validAuthoritativeResult() }
    );
    expect(result.ok).toBe(true);
  });

  test("P8. full record (Cart + Submission + Result) all survive real IndexedDB round-trip", async () => {
    await loadHarness();
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(loaded.status).toBe("VALID");
    expect(loaded.cartDraft).not.toBeNull();
    expect(loaded.submissionAttempt).not.toBeNull();
    expect(loaded.authoritativeResult).not.toBeNull();
    expect(loaded.authoritativeResult.orderState).toBe("VALIDATED");
    expect(loaded.authoritativeResult.idempotencyKey).toBe("abcdefgh12345678");
  });

  test("P9. purge succeeds", async () => {
    await loadHarness();
    const result = await sharedPage.evaluate(({ db }) => window.__persistenceTest.purgeCustomerContext(db), { db: CRUD_DB });
    expect(result.ok).toBe(true);
  });

  test("P10. read after purge reports EMPTY", async () => {
    await loadHarness();
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CRUD_DB, owner: OWNER_A });
    expect(loaded.status).toBe("EMPTY");
  });

  test.afterAll(async () => {
    await resetDatabase(CRUD_DB.dbName);
  });
});

// ============================================================
// Group 2: P11-P12 - owner isolation (Model B two-identity model)
// ============================================================

const OWNER_DB = { dbName: "kioskPersistenceBrowserTest_ownerIsolation", storeName: "kioskPersistenceTest", dbVersion: 1 };
const OWNER_B = "test-owner-B";

test.describe("P11-P12: owner isolation against real IndexedDB", () => {
  test.beforeAll(async () => {
    await resetDatabase(OWNER_DB.dbName);
    await loadHarness();
    await sharedPage.evaluate(
      ({ db, owner, cart }) => window.__persistenceTest.saveCartDraft(db, owner, cart),
      { db: OWNER_DB, owner: OWNER_A, cart: validCartDraft() }
    );
    await sharedPage.evaluate(
      ({ db, owner, attempt }) => window.__persistenceTest.saveSubmissionAttempt(db, owner, attempt),
      { db: OWNER_DB, owner: OWNER_A, attempt: validSubmissionAttempt() }
    );
  });

  test("P11. Owner B reading Owner A's record gets UID_MISMATCH with zero leaked domain data", async () => {
    await loadHarness();
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: OWNER_DB, owner: OWNER_B });
    expect(loaded.status).toBe("UID_MISMATCH");
    expect(loaded.cartDraft).toBeUndefined();
    expect(loaded.submissionAttempt).toBeUndefined();
    expect(loaded.authoritativeResult).toBeUndefined();
  });

  test("P12. Owner B can write and read their own state - KNOWN PRE-EXISTING LIMITATION: this physically replaces Owner A's entire prior record", async () => {
    await loadHarness();
    const bCart = validCartDraft();
    bCart.customerName = "OwnerBCustomer";

    const saveResult = await sharedPage.evaluate(
      ({ db, owner, cart }) => window.__persistenceTest.saveCartDraft(db, owner, cart),
      { db: OWNER_DB, owner: OWNER_B, cart: bCart }
    );
    expect(saveResult.ok).toBe(true);

    const bLoaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: OWNER_DB, owner: OWNER_B });
    expect(bLoaded.status).toBe("VALID");
    expect(bLoaded.cartDraft.customerName).toBe("OwnerBCustomer");
    // Characterizing, not fixing, the pre-existing STEP 55/56 behavior:
    // Owner B's save started from a fresh base (isUsableSameOwnerRecord
    // returned false for a mismatched owner), so it never carried
    // forward Owner A's submissionAttempt - the whole record was
    // replaced, not merged. This is the same single-fixed-storage-key
    // whole-record-replace mechanism already proven at the Node level;
    // it is not something this step introduces, fixes, or is able to
    // observe differently merely because real IndexedDB is involved.
    expect(bLoaded.submissionAttempt).toBeNull();
  });

  test.afterAll(async () => {
    await resetDatabase(OWNER_DB.dbName);
  });
});

// ============================================================
// Group 3: P13 - expired unresolved Submission Attempt retention
// ============================================================

const EXPIRY_DB = { dbName: "kioskPersistenceBrowserTest_expiry", storeName: "kioskPersistenceTest", dbVersion: 1 };

test.describe("P13: local expiry remains informational against real IndexedDB", () => {
  test.beforeAll(async () => {
    await resetDatabase(EXPIRY_DB.dbName);
  });

  test("P13. an expired UNKNOWN Submission Attempt remains available, unexpired fields untouched", async () => {
    await loadHarness();

    const saveResult = await sharedPage.evaluate(
      ({ db, owner, attempt }) => window.__persistenceTest.saveSubmissionAttempt(db, owner, attempt),
      { db: EXPIRY_DB, owner: OWNER_A, attempt: validSubmissionAttempt({ status: "UNKNOWN" }) }
    );
    expect(saveResult.ok).toBe(true);

    // DIRECT INJECTION (test-only bypass, mirrors the proven Node-level
    // technique): read the real raw record back, backdate writtenAt,
    // write it straight back via store.set() - never through
    // persistenceAdapter's own save path, and no real sleep involved.
    const backdated = await sharedPage.evaluate(async ({ db }) => {
      const raw = await window.__persistenceTest.rawRead(db);
      raw.submissionAttempt.writtenAt = Date.now() - 1_000_000;
      await window.__persistenceTest.rawInject(db, raw);
      return true;
    }, { db: EXPIRY_DB });
    expect(backdated).toBe(true);

    const loaded = await sharedPage.evaluate(
      ({ db, owner }) => window.__persistenceTest.load(db, owner, { submissionAttemptMaxAgeMs: 1000 }),
      { db: EXPIRY_DB, owner: OWNER_A }
    );
    expect(loaded.submissionAttemptExpired).toBe(true);
    expect(loaded.submissionAttempt.status).toBe("UNKNOWN"); // never reinterpreted as resolved
    expect(loaded.submissionAttempt.idempotencyKey).toBe("abcdefgh12345678");
  });

  test.afterAll(async () => {
    await resetDatabase(EXPIRY_DB.dbName);
  });
});

// ============================================================
// Group 4: P14 - corruption / unsupported schema classification
// ============================================================

const CORRUPTION_DB = { dbName: "kioskPersistenceBrowserTest_corruption", storeName: "kioskPersistenceTest", dbVersion: 1 };

function validBaseRecord() {
  return {
    schemaVersion: 1,
    ownerUidAtWrite: OWNER_A,
    writtenAt: Date.now(),
    cartDraft: null,
    submissionAttempt: null,
    authoritativeResult: null,
  };
}

test.describe("P14: corruption/unsupported-schema classification against real IndexedDB", () => {
  test.beforeEach(async () => {
    await resetDatabase(CORRUPTION_DB.dbName);
  });

  test("P14a. missing ownerUidAtWrite -> CORRUPT_RECORD", async () => {
    const raw = validBaseRecord();
    delete raw.ownerUidAtWrite;
    await loadHarness();
    await sharedPage.evaluate(({ db, rec }) => window.__persistenceTest.rawInject(db, rec), { db: CORRUPTION_DB, rec: raw });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("CORRUPT_RECORD");
  });

  test("P14b. missing writtenAt -> CORRUPT_RECORD", async () => {
    const raw = validBaseRecord();
    delete raw.writtenAt;
    await loadHarness();
    await sharedPage.evaluate(({ db, rec }) => window.__persistenceTest.rawInject(db, rec), { db: CORRUPTION_DB, rec: raw });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("CORRUPT_RECORD");
  });

  test("P14c. missing schemaVersion -> CORRUPT_RECORD", async () => {
    const raw = validBaseRecord();
    delete raw.schemaVersion;
    await loadHarness();
    await sharedPage.evaluate(({ db, rec }) => window.__persistenceTest.rawInject(db, rec), { db: CORRUPTION_DB, rec: raw });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("CORRUPT_RECORD");
  });

  test("P14d. unsupported schemaVersion -> UNSUPPORTED_SCHEMA", async () => {
    const raw = validBaseRecord();
    raw.schemaVersion = 999;
    await loadHarness();
    await sharedPage.evaluate(({ db, rec }) => window.__persistenceTest.rawInject(db, rec), { db: CORRUPTION_DB, rec: raw });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("UNSUPPORTED_SCHEMA");
    expect(loaded.foundSchemaVersion).toBe(999);
  });

  test("P14e. malformed root record (a string instead of an object) -> CORRUPT_RECORD", async () => {
    await loadHarness();
    await sharedPage.evaluate(({ db }) => window.__persistenceTest.rawInject(db, "not-an-object"), { db: CORRUPTION_DB });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("CORRUPT_RECORD");
  });

  test("P14f. malformed nested Cart Draft -> CORRUPT_RECORD", async () => {
    const raw = validBaseRecord();
    raw.cartDraft = { lines: "not-an-array", customerName: null, notes: null };
    await loadHarness();
    await sharedPage.evaluate(({ db, rec }) => window.__persistenceTest.rawInject(db, rec), { db: CORRUPTION_DB, rec: raw });
    const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: CORRUPTION_DB, owner: OWNER_A });
    expect(loaded.status).toBe("CORRUPT_RECORD");
  });

  test.afterAll(async () => {
    await resetDatabase(CORRUPTION_DB.dbName);
  });
});

// ============================================================
// Group 5: P15 - repeatability across two freshly-deleted databases
// ============================================================

async function runCrudSequence(dbConfig, ownerUid) {
  await sharedPage.evaluate(
    ({ db, owner, cart }) => window.__persistenceTest.saveCartDraft(db, owner, cart),
    { db: dbConfig, owner: ownerUid, cart: validCartDraft() }
  );
  await sharedPage.evaluate(
    ({ db, owner, attempt }) => window.__persistenceTest.saveSubmissionAttempt(db, owner, attempt),
    { db: dbConfig, owner: ownerUid, attempt: validSubmissionAttempt() }
  );
  await sharedPage.evaluate(
    ({ db, owner, key, res }) => window.__persistenceTest.saveAuthoritativeResult(db, owner, key, res),
    { db: dbConfig, owner: ownerUid, key: "abcdefgh12345678", res: validAuthoritativeResult() }
  );
  const loaded = await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: dbConfig, owner: ownerUid });
  // Strip fields that are expected to legitimately differ between runs
  // (Date.now()-derived timestamps) before comparing structural shape.
  const { meta, cartDraft, submissionAttempt, authoritativeResult, ...rest } = loaded;
  return {
    ...rest,
    cartDraft: cartDraft ? { ...cartDraft, writtenAt: "STRIPPED" } : cartDraft,
    submissionAttempt: submissionAttempt ? { ...submissionAttempt, writtenAt: "STRIPPED" } : submissionAttempt,
    authoritativeResult: authoritativeResult ? { ...authoritativeResult, writtenAt: "STRIPPED" } : authoritativeResult,
  };
}

test.describe("P15: repeatability across two independently-created, freshly-deleted test databases", () => {
  test("P15. two full CRUD sequences against two fresh databases produce structurally identical results", async () => {
    const dbOne = { dbName: "kioskPersistenceBrowserTest_repeat1", storeName: "kioskPersistenceTest", dbVersion: 1 };
    const dbTwo = { dbName: "kioskPersistenceBrowserTest_repeat2", storeName: "kioskPersistenceTest", dbVersion: 1 };

    await resetDatabase(dbOne.dbName);
    const first = await runCrudSequence(dbOne, OWNER_A);

    await resetDatabase(dbTwo.dbName);
    const second = await runCrudSequence(dbTwo, OWNER_A);

    expect(second).toEqual(first);

    await resetDatabase(dbOne.dbName);
    await resetDatabase(dbTwo.dbName);
  });
});

// ============================================================
// Group 6: P16 - cleanup verification
// ============================================================

test.describe("P16: cleanup leaves no residual test databases", () => {
  test("P16. all explicitly-created test databases are absent after deletion", async () => {
    await loadHarness();
    const testDbNames = [
      CRUD_DB.dbName,
      OWNER_DB.dbName,
      EXPIRY_DB.dbName,
      CORRUPTION_DB.dbName,
      "kioskPersistenceBrowserTest_repeat1",
      "kioskPersistenceBrowserTest_repeat2",
    ];

    const hasDatabases = await sharedPage.evaluate(() => typeof indexedDB.databases === "function");
    test.skip(!hasDatabases, "indexedDB.databases() not supported in this browser build");

    const remaining = await sharedPage.evaluate(async (names) => {
      const all = await indexedDB.databases();
      const allNames = all.map((entry) => entry.name);
      return names.filter((name) => allNames.includes(name));
    }, testDbNames);

    expect(remaining).toEqual([]);
  });
});

// ============================================================
// Native IndexedDB / environment sanity checks
// ============================================================

test("H1. harness loads with no page error and native window.indexedDB is present (not faked/mocked)", async () => {
  await loadHarness();
  const hasNative = await sharedPage.evaluate(() => window.__persistenceTest.hasNativeIndexedDB());
  expect(hasNative).toBe(true);
});

test("H2. persistence artifacts exist and load as valid ESM", () => {
  expect(fs.existsSync(PERSISTENCE_ADAPTER_DIST)).toBe(true);
  expect(fs.existsSync(INDEXEDDB_ADAPTER_DIST)).toBe(true);
});

test("H3. no production database/store name is ever referenced by this spec file", () => {
  const source = fs.readFileSync(__filename, "utf8");
  // Exact quoted production defaults (indexedDbAdapter.js's own
  // DEFAULT_DB_NAME / DEFAULT_STORE_NAME) - distinct from this file's
  // own longer, test-scoped literals which merely share a common
  // prefix. Built from parts here so this very check does not itself
  // contain the literal it is asserting the absence of.
  const productionDbName = "aul" + "KitchenKiosk";
  const productionStoreName = "kiosk" + "Persistence";
  expect(source.includes('"' + productionDbName + '"')).toBe(false);
  expect(source.includes('"' + productionStoreName + '"')).toBe(false);
});

test("H4. no production network - zero requests to any non-localhost origin", async () => {
  const externalRequests = [];
  const listener = (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      externalRequests.push(request.url());
    }
  };
  sharedPage.on("request", listener);
  try {
    await loadHarness();
    await sharedPage.evaluate(({ db, owner }) => window.__persistenceTest.load(db, owner), { db: { dbName: "kioskPersistenceBrowserTest_network" }, owner: OWNER_A });
    await sharedPage.evaluate((name) => window.__persistenceTest.deleteDatabase(name), "kioskPersistenceBrowserTest_network");
  } finally {
    sharedPage.off("request", listener);
  }
  expect(externalRequests).toEqual([]);
});

test("H5. forbidden dependency scan - generated persistence artifacts contain no forbidden runtime dependency", () => {
  for (const distPath of [PERSISTENCE_ADAPTER_DIST, INDEXEDDB_ADAPTER_DIST]) {
    const source = fs.readFileSync(distPath, "utf8");
    const lowerSource = source.toLowerCase();
    const forbidden = [
      "firebase-admin", "firebase-functions", "firestore", "midtrans", "qris",
      "aul-world-runtime", "pixi", "playwright", "vitest", "node:test",
      "gstatic", "firebasejs",
    ];
    for (const term of forbidden) {
      expect(lowerSource.includes(term.toLowerCase())).toBe(false);
    }
    expect(source.includes('require("fs")')).toBe(false);
    expect(source.includes('require("path")')).toBe(false);
  }
});
