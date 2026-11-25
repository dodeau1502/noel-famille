// Alertes de l'état des sources (site/index.html, lot K-complet) : extraites de la page et testées hors navigateur
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
const m = html.match(/const SRC_LABEL = [\s\S]*?\nfunction sourceAlerts[\s\S]*?\n}\n/);
assert.ok(m, "sourceAlerts introuvable");
const alerts = new Function(`${m[0]}; return sourceAlerts;`)();
const at = (h, min = 0) => new Date(2026, 10, 30, h, min);               // heure locale
const ago = (now, min) => new Date(now.getTime() - min * 60e3).toISOString();

let now = at(14);
assert.deepEqual(alerts([{ name: "dealabs:tous", last_ok: ago(now, 5) }], now), []);
assert.equal(alerts([{ name: "dealabs:tous", last_ok: ago(now, 16) }], now).length, 1);
assert.deepEqual(alerts([{ name: "dealabs:tous", last_ok: ago(now, 15) }], now), []);
now = at(3);                                                               // la nuit, le silence est toléré
assert.deepEqual(alerts([{ name: "dealabs:tous", last_ok: ago(now, 120) }], now), []);
now = at(0, 30);                                                           // jusqu'à 1 h du matin : surveillé
assert.equal(alerts([{ name: "dealabs:tous", last_ok: ago(now, 40) }], now).length, 1);
now = at(14);
assert.equal(alerts([{ name: "dealabs:tous", last_ok: null, last_error: "HTTP 429" }], now).length, 1);
// autres sources : alerte au-delà de 3 fois l'intervalle (hot : 10 min => 30 min), jamais pour une source qui n'a jamais tourné
assert.equal(alerts([{ name: "dealabs:hot", last_ok: ago(now, 31) }], now).length, 1);
assert.deepEqual(alerts([{ name: "dealabs:hot", last_ok: ago(now, 29) }], now), []);
assert.deepEqual(alerts([{ name: "keepa", last_ok: null }], now), []);
// test quotidien : un échec plus récent que le dernier succès
assert.equal(alerts([{ name: "selftest", last_ok: ago(now, 600), last_error: "format", last_error_at: ago(now, 5) }], now).length, 1);
assert.deepEqual(alerts([{ name: "selftest", last_ok: ago(now, 5), last_error: "vieux", last_error_at: ago(now, 600) }], now), []);
assert.deepEqual(alerts(null, now), []);
console.log("source alerts OK");
