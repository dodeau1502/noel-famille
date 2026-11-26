import assert from "node:assert/strict";
import { isMarket, parsePrice, cleanUrl, storeFromHost, buildOffers, totalOf, dupOf, normalizeSite, extractCode } from "../lib.js";

// Places de marché et comparateurs
for (const [s, u] of [["Leboncoin", ""], ["", "https://www.ebay.fr/itm/1"], ["idealo", "https://www.idealo.fr/x"], ["foto-erhardtfr", ""], ["Vinted", ""]]) assert.ok(isMarket(s, u), s + u);
for (const [s, u] of [["Boulanger", "https://www.boulanger.com/ref/1"], ["Amazon.fr", "https://www.amazon.fr/dp/B0"], ["Fnac", ""], ["Darty", "https://www.darty.com/x"]]) assert.ok(!isMarket(s, u), s + u);

// Prix
assert.equal(parsePrice("1 299,00 €"), 1299);
assert.equal(parsePrice("129,90"), 129.9);
assert.equal(parsePrice("1,299.00"), 1299);
assert.equal(parsePrice("1.299,50"), 1299.5);
assert.equal(parsePrice("1.299"), 1299);
assert.equal(parsePrice("12.5"), 12.5);
assert.equal(parsePrice(279), 279);
assert.equal(parsePrice("0"), null);
assert.equal(parsePrice("gratuit"), null);
assert.equal(parsePrice("250000"), null);

// Adresses
assert.equal(cleanUrl("https://x.fr/p/1?utm_source=a&color=noir&gclid=zz#avis"), "https://x.fr/p/1?color=noir");
assert.equal(cleanUrl("javascript:alert(1)"), "");
assert.equal(storeFromHost("www.boulanger.com"), "Boulanger");
assert.equal(storeFromHost("www.amazon.fr"), "Amazon.fr");
assert.equal(storeFromHost("shop.exemple.co.uk"), "Exemple");
assert.equal(storeFromHost("www.darty.com", "Darty"), "Darty");
assert.equal(normalizeSite("liste.exemple.fr/gestion"), "https://liste.exemple.fr");
assert.equal(normalizeSite("ftp://x"), "");
assert.equal(extractCode("https://liste.exemple.fr/#c=ab%20cd"), "ab cd");
assert.equal(extractCode("  motdepasse  "), "motdepasse");

// Offres
const page = { url: "https://www.boulanger.com/ref/1", store: "Boulanger", price: 229, stockOut: false };
let r = buildOffers(null, page, "2026-11-14T22:00:00Z");
assert.equal(r.offers.length, 1);
assert.equal(r.offers[0].verified, false);
assert.equal(r.offers[0].at, "2026-11-14T22:00:00Z");
assert.equal(r.best.store, "Boulanger");
// page d'une place de marché : aucune offre
r = buildOffers(null, { ...page, url: "https://www.leboncoin.fr/ad/1", store: "Leboncoin" });
assert.equal(r.offers.length, 0); assert.equal(r.best, null);
// page http : aucune offre (le site n'accepte que https)
assert.equal(buildOffers(null, { ...page, url: "http://www.boulanger.com/x" }).offers.length, 0);
// recherche : places de marché écartées, offre de la page ajoutée seulement si son site n'y est pas
const search = { offers: [
  { store: "Darty", price: 235, shipping: 0, url: "https://www.darty.com/x", verified: true, at: "2026-11-14T20:00:00Z", trust: { l: "known", r: [] } },
  { store: "Leboncoin", price: 100, url: "https://www.leboncoin.fr/1" },
  { store: "Boulanger", price: 240, shipping: 5, url: "https://www.boulanger.com/other" },
] };
r = buildOffers(search, page);
assert.deepEqual(r.offers.map(o => o.store).sort(), ["Boulanger", "Darty"]);
assert.equal(r.offers.find(o => o.store === "Boulanger").price, 240, "l'offre du même site vient de la recherche, pas de doublon");
assert.equal(r.best.store, "Darty");
assert.equal(totalOf(r.best), 235);
// rupture de stock : jamais la meilleure
r = buildOffers(null, { ...page, stockOut: true });
assert.equal(r.offers[0].stock, "out"); assert.equal(r.best, null);

// Doublons
const gifts = [{ title: "Casque Sony WH-1000XM5", url: "https://www.boulanger.com/ref/9?utm_source=x" }, { title: "Cocotte Staub 24 cm" }];
assert.ok(dupOf(gifts, "Sony WH-1000XM5 casque", ""));
assert.ok(dupOf(gifts, "Autre chose", "https://www.boulanger.com/ref/9"));
assert.ok(!dupOf(gifts, "Casque Sony WH-1000XM4", ""), "un chiffre différent n'est pas un doublon");
assert.ok(!dupOf(gifts, "Cocotte Staub 28 cm", ""));
console.log("lib.test.mjs : OK");

// Mise à jour du prix d'un cadeau existant
{
  const { giftForPage, updatedOffers } = await import("../lib.js");
  const assert = (await import("node:assert/strict")).default;
  const gifts = [
    { id: 1, title: "Drap de bain", offers: [{ store: "Greige", price: 55, url: "https://www.greige.fr/products/drap" }] },
    { id: 2, title: "Parure de lit", offers: [{ store: "Greige", price: 212, url: "https://www.greige.fr/products/parure" }] },
    { id: 3, title: "Pull", offers: [{ store: "UNIQLO", price: 49.9, url: "https://www.uniqlo.com/p/1", verified: true, shipping: 3 }] },
  ];
  assert.equal(giftForPage(gifts, "x", "https://greige.fr/products/parure?v=1").id, 2);
  assert.equal(giftForPage(gifts, "x", "https://www.uniqlo.com/autre").id, 3);
  assert.equal(giftForPage(gifts, "x", "https://www.greige.fr/autre"), null);
  const o = updatedOffers(gifts[2], { url: "https://www.uniqlo.com/p/1", store: "Uniqlo FR", price: 39.9, stockOut: false }, "2026-11-26T10:00:00.000Z");
  assert.deepEqual([o.length, o[0].store, o[0].price, o[0].shipping, o[0].verified, o[0].via, o[0].at], [1, "UNIQLO", 39.9, 3, false, "page", "2026-11-26T10:00:00.000Z"]);
  assert.equal(updatedOffers(gifts[2], { url: "https://www.decathlon.fr/x", store: "Decathlon", price: 10 }).length, 2);
  assert.equal(updatedOffers(gifts[2], { url: "https://www.ebay.fr/x", store: "eBay", price: 10 }), null);
  assert.equal(updatedOffers(gifts[2], { url: "https://www.uniqlo.com/p/1", store: "U", price: null }), null);
  console.log("mise à jour du prix OK");
}
