"use strict";

/**
 * STEP89 — Node-side (not browser) seeding for the Firestore Emulator.
 * Uses firebase-admin directly against FIRESTORE_EMULATOR_HOST, exactly
 * as the real orderIntent Cloud Function's repositories do - this
 * bypasses Security Rules entirely (Admin SDK always does), which is why
 * no firestore.rules file is required for this project (STEP89 Guru
 * review finding: Firestore Emulator REQUIRED, rules file NOT REQUIRED -
 * the emulator defaults to allowing all reads/writes when none is
 * configured, and Admin SDK ignores rules regardless).
 *
 * Refuses to run unless FIRESTORE_EMULATOR_HOST is set, so this can never
 * accidentally write to real production Firestore.
 */

const admin = require("firebase-admin");

const PROJECT_ID = "demo-orderintent-test";

const OK_PRODUCT_ID = "step89-product-ok";
const OK_INGREDIENT_ID = "step89-ingredient-ok";
const SHORTAGE_PRODUCT_ID = "step89-product-shortage";
const SHORTAGE_INGREDIENT_ID = "step89-ingredient-shortage";

const RECIPE_QTY_PER_UNIT = 2;
const OK_INGREDIENT_STARTING_STOCK = 100;
const SHORTAGE_INGREDIENT_STARTING_STOCK = 1;

function getApp() {
  if (admin.apps.length > 0) return admin.apps[0];
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set - refusing to initialize firebase-admin. " +
        "This module must never run against real production Firestore."
    );
  }
  return admin.initializeApp({ projectId: PROJECT_ID });
}

async function seedFixtures() {
  const app = getApp();
  const db = admin.firestore(app);

  await db.collection("ingredients").doc(OK_INGREDIENT_ID).set({
    name: "STEP89 Test Ingredient (sufficient stock)",
    unit: "pcs",
    stock: OK_INGREDIENT_STARTING_STOCK,
    avgCost: 100,
    minStock: 0,
  });

  await db.collection("ingredients").doc(SHORTAGE_INGREDIENT_ID).set({
    name: "STEP89 Test Ingredient (insufficient stock)",
    unit: "pcs",
    stock: SHORTAGE_INGREDIENT_STARTING_STOCK,
    avgCost: 100,
    minStock: 0,
  });

  await db.collection("products").doc(OK_PRODUCT_ID).set({
    name: "STEP89 Test Product (OK)",
    price: 15000,
    category: "step89-test",
    categoryLabel: "STEP89 Test",
    categoryOrder: 0,
    itemOrder: 0,
    recipe: [
      {
        ingredientId: OK_INGREDIENT_ID,
        ingredientName: "STEP89 Test Ingredient (sufficient stock)",
        qty: RECIPE_QTY_PER_UNIT,
      },
    ],
    modifierGroups: [],
  });

  await db.collection("products").doc(SHORTAGE_PRODUCT_ID).set({
    name: "STEP89 Test Product (Shortage)",
    price: 15000,
    category: "step89-test",
    categoryLabel: "STEP89 Test",
    categoryOrder: 0,
    itemOrder: 0,
    recipe: [
      {
        ingredientId: SHORTAGE_INGREDIENT_ID,
        ingredientName: "STEP89 Test Ingredient (insufficient stock)",
        qty: RECIPE_QTY_PER_UNIT,
      },
    ],
    modifierGroups: [],
  });
}

async function readIngredientStock(ingredientId) {
  const app = getApp();
  const db = admin.firestore(app);
  const doc = await db.collection("ingredients").doc(ingredientId).get();
  if (!doc.exists) return null;
  return doc.data().stock;
}

module.exports = {
  PROJECT_ID,
  OK_PRODUCT_ID,
  OK_INGREDIENT_ID,
  SHORTAGE_PRODUCT_ID,
  SHORTAGE_INGREDIENT_ID,
  RECIPE_QTY_PER_UNIT,
  OK_INGREDIENT_STARTING_STOCK,
  SHORTAGE_INGREDIENT_STARTING_STOCK,
  seedFixtures,
  readIngredientStock,
};
