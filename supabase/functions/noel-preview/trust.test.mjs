import assert from "node:assert/strict";
import { assess, isKnown, belowMedian, ageFromRdap, isBlocked, registrable, keyOf } from "./trust.js";

const G = "https://www.google.fr/goto?url=abc";
// Marchands connus : par domaine quand la page est connue, par nom quand le lien est celui de Google
assert.equal(isKnown("Fnac.com", G), true);
assert.equal(isKnown("Amazon.fr", G), true);
assert.equal(isKnown("DJI Official Store", G), true);
assert.equal(isKnown("E.Leclerc", G), true);
assert.equal(isKnown("Fnac", "https://www.fnac.com/Drone-Dji/a1"), true);
assert.equal(isKnown("Boutique X", "https://www.boulanger.com/ref/1"), true);
// Usurpation : nom connu mais domaine inconnu, ou domaine qui ressemble
assert.equal(isKnown("Fnac", "https://fnac-promo.shop/a"), false);
assert.equal(isKnown("Fnac", "https://fnac.com.evil.ru/a"), false);
assert.equal(isKnown("x", "https://evilfnac.com/a"), false);
assert.equal(isKnown("Patrick Modélisme", "https://www.patrick-modelisme.fr/p"), false);
assert.equal(isKnown("But Soldes Pas Cher", G), false);

// Niveaux
assert.deepEqual(assess({ store: "Fnac.com", url: G }, { rating: 1, reviews: 900, ageDays: 5 }), { l: "known", r: [] });   // un marchand connu n'est pas jugé sur les signaux
assert.equal(assess({ store: "Petite Boutique", url: "https://petite.fr/p" }).l, "unknown");
assert.equal(assess({ store: "Petite Boutique", url: "https://petite.fr/p" }, { rating: 4.5, reviews: 300, ageDays: 2000, belowMedian: 0.05 }).l, "unknown");
let a = assess({ store: "B", url: "https://b.fr/p" }, { rating: 3.2, reviews: 40 });
assert.equal(a.l, "caution"); assert.match(a.r[0], /3,2\/5 sur 40 avis/);
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { rating: 3.2, reviews: 10 }).l, "unknown");   // trop peu d'avis pour juger
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { rating: 2.5, reviews: 80 }).l, "out");
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { rating: 2.5, reviews: 30 }).l, "caution");
a = assess({ store: "B", url: "https://b.fr/p" }, { ageDays: 120 });
assert.equal(a.l, "caution"); assert.match(a.r[0], /4 mois/);
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { ageDays: 40 }).l, "out");
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { ageDays: 400 }).l, "unknown");
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { ageDays: null }).l, "unknown");                  // âge inconnu : jamais un motif d'exclusion
a = assess({ store: "B", url: "https://b.fr/p" }, { belowMedian: 0.3 });
assert.equal(a.l, "caution"); assert.match(a.r[0], /30 %/);
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, { belowMedian: 0.1 }).l, "unknown");
assert.equal(assess({ store: "B", url: "https://b.fr/p" }, {}).r.length, 0);

// Prix sous la médiane des autres (au moins 2 autres)
assert.equal(belowMedian(100, [200]), null);
assert.equal(belowMedian(150, [200, 200]), 0.25);
assert.equal(belowMedian(300, [200, 200]), 0);

// Âge du domaine d'après RDAP
const now = new Date("2026-10-31T12:00:00Z");
assert.equal(ageFromRdap({ events: [{ eventAction: "registration", eventDate: "2026-09-21T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-09-21T00:00:00Z" }] }, now), 40);
assert.equal(ageFromRdap({ events: [{ eventAction: "last changed", eventDate: "2026-01-01T00:00:00Z" }] }, now), null);
assert.equal(ageFromRdap({}, now), null);
assert.equal(ageFromRdap(null, now), null);
assert.equal(ageFromRdap({ events: [{ eventAction: "registration", eventDate: "2030-01-01T00:00:00Z" }] }, now), null);   // date future : ignorée

// Domaine enregistrable
assert.equal(registrable("www.patrick-modelisme.fr"), "patrick-modelisme.fr");
assert.equal(registrable("shop.exemple.co.uk"), "exemple.co.uk");
assert.equal(registrable("localhost"), "");

// Liste noire : par nom (accents et ponctuation ignorés) ou par domaine
const bl = { keys: new Set([keyOf("Patrick Modélisme")]), hosts: new Set(["mauvais.shop"]) };
assert.equal(isBlocked({ store: "patrick modelisme", url: G }, bl), true);
assert.equal(isBlocked({ store: "Autre", url: "https://www.mauvais.shop/p" }, bl), true);
assert.equal(isBlocked({ store: "Autre", url: "https://shop.mauvais.shop/p" }, bl), true);
assert.equal(isBlocked({ store: "Autre", url: "https://pasmauvais.shop/p" }, bl), false);
assert.equal(isBlocked({ store: "Autre", url: G }, bl), false);
assert.equal(isBlocked({ store: "Autre", url: G }, null), false);
console.log("trust OK");
