import assert from "node:assert/strict";
import { nextCheck, INPUT_KEYS, inHighPeriod, lastChange, offerDue, readableCount, isUnreadable, DomainThrottle, takeReads } from "./schedule.js";
const NOW = new Date("2026-11-30T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
const mins = (i, r = () => 0.5) => Math.round((nextCheck({ readableCount: 2, ...i }, NOW, r) - NOW) / 60e3);

// une ligne du tableau chacune (rand = 0.5 : aucun décalage)
assert.equal(mins({ lastSignalAt: ago(5) }), 15);
assert.equal(mins({ lastChangeAt: ago(47) }), 30);
assert.equal(mins({ inHighPeriod: true }), 45);
assert.equal(mins({}), 60);
assert.equal(mins({ readableCount: 0 }), 360);
// priorité : piste récente > changement > période forte > général ; aucune offre lisible l'emporte sur tout
assert.equal(mins({ lastSignalAt: ago(1), lastChangeAt: ago(1), inHighPeriod: true }), 15);
assert.equal(mins({ lastSignalAt: ago(7), lastChangeAt: ago(1), inHighPeriod: true }), 30);
assert.equal(mins({ lastSignalAt: ago(7), lastChangeAt: ago(50), inHighPeriod: true }), 45);
assert.equal(mins({ lastSignalAt: ago(1), readableCount: 0 }), 360);
// décalage aléatoire de ±10 %
for (const r of [0, 0.25, 0.999]) { const m = mins({}, () => r); assert.ok(m >= 54 && m <= 66, String(m)); }

// confidentialité : l'entrée est gelée et un Proxy lève une erreur sur toute clé hors liste
const guard = (o) => new Proxy(Object.freeze({ ...o }), { get(t, k) { if (typeof k === "string" && !INPUT_KEYS.includes(k)) throw new Error("clé interdite : " + k); return t[k]; } });
assert.doesNotThrow(() => nextCheck(guard({ readableCount: 1, lastSignalAt: null, lastChangeAt: null, inHighPeriod: false }), NOW));
for (const k of ["claimed", "claimed_by", "bought", "paid"]) {
  const p = guard({ readableCount: 1, [k]: true });
  assert.throws(() => p[k], /interdite/);
}

assert.equal(inHighPeriod(NOW, "2026-11-27/2026-12-01,2026-12-14/2026-12-24"), true);
assert.equal(inHighPeriod(new Date("2026-12-05T12:00:00Z"), "2026-11-27/2026-12-01,2026-12-14/2026-12-24"), false);
assert.equal(inHighPeriod(NOW, ""), false);

// dernier changement vérifié
assert.equal(lastChange([{ mkey: "a", total: 100, verified: true, at: ago(100) }, { mkey: "a", total: 90, verified: true, at: ago(30) }, { mkey: "a", total: 90, verified: true, at: ago(5) }]), ago(30));
assert.equal(lastChange([{ mkey: "a", total: 100, verified: false, at: ago(10) }, { mkey: "a", total: 90, verified: false, at: ago(5) }]), null);

// offres : illisibles jamais relues, 3 échecs => une fois par 24 h
assert.equal(isUnreadable("https://www.amazon.fr/dp/X"), true); assert.equal(isUnreadable("https://www.ldlc.com/x"), false);
assert.equal(offerDue({ url: "https://www.fnac.com/a" }, NOW), false);
assert.equal(offerDue({ url: "https://ldlc.com/a", fails: 2 }, NOW), true);
assert.equal(offerDue({ url: "https://ldlc.com/a", fails: 3, tried_at: ago(5) }, NOW), false);
assert.equal(offerDue({ url: "https://ldlc.com/a", fails: 3, tried_at: ago(25) }, NOW), true);
assert.equal(offerDue({ url: "https://ldlc.com/a", fails: 9, tried_at: ago(1) }, NOW, true), true);
assert.equal(readableCount([{ url: "https://amazon.fr/dp/x" }, { url: "https://ldlc.com/a" }]), 1);

// plafond par domaine : 20 s d'écart, 60 par heure
const t = new DomainThrottle();
assert.equal(t.reserve("www.ldlc.com", 0), 0); assert.equal(t.reserve("ldlc.com", 0), 20e3); assert.equal(t.reserve("ldlc.com", 0), 40e3);
assert.equal(t.reserve("ldlc.com", 0), 60e3); assert.equal(t.reserve("ldlc.com", 0), -1);   // au-delà de 60 s d'attente : refusé
assert.equal(t.reserve("cdiscount.com", 0), 0);
const t2 = new DomainThrottle(0, 60); let ok = 0; for (let i = 0; i < 70; i++) if (t2.reserve("x.fr", i * 1000) >= 0) ok++;
assert.equal(ok, 60);

// plafond global : 120 par heure
let src = null, total = 0;
for (let m = 0; m < 120; m++) { const r = takeReads(src, 3, 120, new Date(NOW.getTime() + m * 60e3)); src = r.src; total += r.allowed; }
assert.equal(total, 240);                                          // 2 h simulées : 120 par heure, jamais plus
assert.equal(takeReads({ window_start: ago(2), n: 120 }, 3, 120, NOW).allowed, 3);

// simulation 24 h, 9 cadeaux de 5 offres lisibles, cron */10 par lots de 3 : lectures sous le plafond horaire
{
  const next = new Map(Array.from({ length: 9 }, (_, i) => [i, null])); let reads = 0, w = null, maxH = 0, hour = 0, cur = -1;
  for (let m = 0; m < 24 * 60; m += 10) {
    const now = new Date(NOW.getTime() + m * 60e3), h = Math.floor(m / 60); if (h !== cur) { cur = h; hour = 0; }
    const due = [...next].filter(([, d]) => !d || d <= now).sort((a, b) => (a[1] ? a[1] - 0 : -1) - (b[1] ? b[1] - 0 : -1)).slice(0, 3);
    for (const [id] of due) { const r = takeReads(w, 5, 120, now); w = r.src; reads += r.allowed; hour += r.allowed; next.set(id, nextCheck({ readableCount: 5 }, now)); }
    maxH = Math.max(maxH, hour);
  }
  assert.ok(maxH <= 120, "plafond horaire dépassé : " + maxH); assert.ok(reads > 0);
}
console.log("schedule OK");
