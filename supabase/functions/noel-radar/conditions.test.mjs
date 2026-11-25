// node supabase/functions/noel-radar/conditions.test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseFeed } from "./dealabs.js";
import { conditionsOf, isConditional } from "./conditions.js";

const { items } = parseFeed(readFileSync(new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url), "utf8"));
const of = s => { const i = items.find(x => x.title.includes(s)); return conditionsOf(i.title, i.html); };
const types = c => c.map(x => x.type).sort();

let c = of("Ecovacs");
assert.deepEqual(types(c), ["cagnotte", "code"]);
assert.equal(c.find(x => x.type === "code").code, "10DES129");
assert.equal(c.find(x => x.type === "code").label, "Code 10DES129");

c = of("Lenovo");
assert.deepEqual(types(c), ["code"]);
assert.equal(c[0].code, "BLACKFRIDAY");

c = of("TTArtisan");
assert.deepEqual(types(c), ["membre"]);
assert.equal(c[0].label, "Prime");

c = of("Abonnement Prime");
assert.deepEqual(types(c), ["nouveaux", "public"]);

// Philips : « livraison gratuite pour les membres Prime » ne fait PAS un prix réservé ; la cagnotte est informative
c = of("Philips");
assert.deepEqual(types(c), ["cagnotte"]);
assert.equal(isConditional(c), false, "fusion possible");

// Sans condition
assert.deepEqual(of("Garmin"), []);
assert.equal(isConditional([]), false);
assert.equal(isConditional([{ type: "code" }]), true);
assert.equal(isConditional([{ type: "cagnotte" }, { type: "odr" }]), true);

// Autres types
assert.deepEqual(types(conditionsOf("Casque - ODR 30 € remboursés", "")), ["odr"]);
assert.match(conditionsOf("Casque ODR", "<p>30 € remboursés par le fabricant</p>")[0].label, /\(30 €\)/);
assert.deepEqual(types(conditionsOf("Aspirateur via coupon", "")), ["coupon"]);
assert.deepEqual(types(conditionsOf("Aspirateur", "<p>Disponible en magasin Boulanger</p>")), ["magasin"], "en tête de description");
assert.deepEqual(types(conditionsOf("TV en magasin uniquement", "")), ["magasin"]);
assert.deepEqual(types(conditionsOf("Perceuse", "<p>Réservé aux adhérents Leclerc</p>")), ["membre"]);
assert.deepEqual(conditionsOf("Perceuse", "<p>Code promo valable une semaine</p>"), [], "pas de code en minuscules");
assert.deepEqual(conditionsOf("Perceuse", "<p>Code article international: 03770022054332</p>"), [], "un nombre n'est pas un code");
assert.deepEqual(types(conditionsOf("Perceuse", "<p>Cashback de 5 €</p>")), ["cagnotte"]);
console.log("conditions OK");
