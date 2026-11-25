import assert from "node:assert/strict";
import { mkeyOf, shouldRecord, low30, riseBeforeDrop, anomaly, methodOf } from "./observe.js";
const NOW = new Date("2026-11-30T12:00:00Z");
const d = (days, h = 0) => new Date(NOW - days * 86400e3 - h * 3600e3).toISOString();
const series = (vals, v = true) => vals.map((total, i) => ({ mkey: "ldlc", total, verified: v, at: d(vals.length - 1 - i) }));

assert.equal(mkeyOf("Fnac.com"), "fnaccom"); assert.equal(mkeyOf("Boulanger "), "boulanger"); assert.equal(mkeyOf("Électro Dépôt"), "electrodepot");

// riseBeforeDrop
assert.ok(riseBeforeDrop(series([100, 100, 130, 130, 105]), "ldlc", NOW));
assert.equal(riseBeforeDrop(series([100, 100, 95]), "ldlc", NOW), null);
assert.equal(riseBeforeDrop(series([100, 130]), "ldlc", NOW), null);               // hausse seulement
assert.equal(riseBeforeDrop(series([100, 100, 130, 130, 105], false), "ldlc", NOW), null); // non vérifiés ignorés
assert.equal(riseBeforeDrop(series([100, 100, 130, 130, 105]), "autre", NOW), null);

// low30 : non vérifiés ignorés, au-delà de 30 jours ignoré
assert.deepEqual(low30(series([100, 90, 120]), "ldlc", NOW), { total: 90, at: d(1) });
assert.equal(low30(series([100, 90, 120], false), "ldlc", NOW), null);
assert.equal(low30([{ mkey: "ldlc", total: 50, verified: true, at: d(31) }], "ldlc", NOW), null);

// shouldRecord : deux relevés identiques à 1 h : non ; à 21 h : oui ; changement : oui
const last = { total: 100, stock: "in", verified: true, at: d(0, 1) };
assert.equal(shouldRecord(last, { total: 100, stock: "in", verified: true }, NOW), false);
assert.equal(shouldRecord({ ...last, at: d(0, 21) }, { total: 100, stock: "in", verified: true }, NOW), true);
assert.equal(shouldRecord(last, { total: 99, stock: "in", verified: true }, NOW), true);
assert.equal(shouldRecord(last, { total: 100, stock: "out", verified: true }, NOW), true);
assert.equal(shouldRecord(last, { total: 100, stock: "in", verified: false }, NOW), true);
assert.equal(shouldRecord(null, { total: 100 }, NOW), true);

// anomaly : 40 € face à 200, 210, 220 : oui ; avec 2 relevés : non
const others = [200, 210, 220].map((total, i) => ({ mkey: "m" + i, total, verified: true, at: d(i) }));
assert.equal(anomaly(others, 40, NOW), true); assert.equal(anomaly(others, 150, NOW), false);
assert.equal(anomaly(others.slice(0, 2), 40, NOW), false);

assert.equal(methodOf({ verified: true }), "page"); assert.equal(methodOf({ verified: false }), "google");
assert.equal(methodOf({ verified: false, via: "manual" }), "manual"); assert.equal(methodOf({ verified: true, via: "dealabs" }), "dealabs");
console.log("observe OK");
