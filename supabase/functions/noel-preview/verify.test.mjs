import assert from "node:assert/strict";
import { applyPage, bestOffer, rank } from "./verify.js";
const NOW = new Date("2026-11-01T10:00:00Z");
const O = (store, price, extra = {}) => ({ store, price, url: "https://x.fr/" + store, shipping: null, ...extra });
const Q = "DJI Osmo Pocket 3 Creator Combo";

// prix confirmé (écart ≤ 3 %) : la page du marchand fait foi
let r = applyPage(O("LDLC", 299.95), { price: 299.95, stock: "in", prices: 1, title: "x" }, "Sony WH-1000XM5", NOW);
assert.equal(r.verified, true); assert.equal(r.stock, "in"); assert.equal(r.at, NOW.toISOString());
r = applyPage(O("A", 300), { price: 296, stock: "in", prices: 1, title: "" }, "Sony WH-1000XM5", NOW);
assert.equal(r.verified, true); assert.equal(r.price, 296);

// page illisible : dernier prix conservé, non vérifié, pas de date de confirmation inventée
r = applyPage(O("Fnac", 349, { at: "2026-10-30T08:00:00.000Z" }), null, Q, NOW);
assert.equal(r.verified, false); assert.equal(r.price, 349); assert.equal(r.at, "2026-10-30T08:00:00.000Z");
r = applyPage(O("Amazon.fr", 249.99), { price: null, stock: "", prices: 0, title: "Amazon" }, Q, NOW);
assert.equal(r.verified, false);

// écart important : accepté seulement si la page décrit le produit et que la lecture n'est pas ambiguë
r = applyPage(O("E.Leclerc", 449), { price: 416.3, stock: "in", prices: 1, name: "Nintendo Switch 2", title: "" }, "Nintendo Switch 2", NOW);
assert.equal(r.verified, true); assert.equal(r.price, 416.3);
r = applyPage(O("DJI Store", 439), { price: 368, stock: "in", prices: 3, name: "DJI Osmo Pocket 3 Creator Combo", title: "" }, Q, NOW);
assert.equal(r.verified, false); assert.equal(r.price, 439);       // plusieurs prix dans la page
r = applyPage(O("Boulanger", 416.99), { price: 79, stock: "in", prices: 1, name: "Sèche-linge Beko", title: "" }, Q, NOW);
assert.equal(r.verified, false);                                    // autre produit
r = applyPage(O("X", 300), { price: 40, stock: "in", prices: 1, name: "Sony WH-1000XM5", title: "" }, "Sony WH-1000XM5", NOW);
assert.equal(r.verified, false);                                    // prix absurde

// rupture de stock annoncée par la page
r = applyPage(O("Y", 300), { price: 300, stock: "out", prices: 1, title: "" }, "Sony WH-1000XM5", NOW);
assert.equal(r.stock, "out");
const list = [O("Y", 100, { stock: "out" }), O("A", 120), O("B", 110, { shipping: 15 })];
assert.equal(bestOffer(list).store, "A");
assert.deepEqual(rank(list).map(o => o.store), ["A", "B", "Y"]);
assert.equal(bestOffer([O("Y", 1, { stock: "out" })]), null);
console.log("verify OK");
