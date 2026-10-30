import assert from "node:assert/strict";
import { pickOffers, cleanTitle, looksLikeUrl, tokens } from "./offers.js";

const R = (title, source, price, extra = {}) => ({ title, source, extracted_price: price, price: price + " €",
  link: `https://${source.toLowerCase().replace(/\W/g, "")}.fr/p`, product_link: "https://www.google.fr/shopping/product/1", thumbnail: "https://encrypted-tbn0.gstatic.com/x" , ...extra });

const results = [
  R("Sony WH-1000XM5 Casque sans fil à réduction de bruit - Noir", "Boulanger", 329),
  R("Sony WH-1000XM5 Casque Bluetooth Noir", "Amazon.fr", 299),
  R("Sony WH-1000XM5 Casque Bluetooth Noir", "Amazon.fr", 305),           // doublon marchand, plus cher
  R("Sony WH-1000XM5 casque noir", "Fnac", 349),
  R("Coussinets de rechange pour Sony WH-1000XM5", "AccessoirePro", 14.9), // accessoire : prix aberrant
  R("Housse de transport casque", "Cdiscount", 19),                        // autre produit
  R("Sony WH-1000XM4 casque", "Darty", 229),                               // autre modèle
  R("Sony WH-1000XM5 occasion", "Back Market", 0),                         // prix invalide
];
let r = pickOffers(results, "Casque Sony WH-1000XM5");
assert.deepEqual(r.offers.map(o => o.store), ["Amazon.fr", "Boulanger", "Fnac"]);
assert.equal(r.offers[0].price, 299);
assert.ok(r.offers.every(o => o.url.startsWith("https://") && !/google/.test(o.url)));
assert.ok(r.image.startsWith("https://"));
assert.ok(/WH-1000XM5/.test(r.title));

// lien marchand absent : repli sur la page produit Google
const r2 = pickOffers([R("Lampe Philips Hue Go", "Boulanger", 79, { link: undefined })], "Philips Hue Go");
assert.equal(r2.offers.length, 1);
assert.match(r2.offers[0].url, /google/);

// aucun résultat pertinent
assert.deepEqual(pickOffers([R("Grille-pain inox", "Darty", 30)], "Casque Sony WH-1000XM5").offers, []);
assert.deepEqual(pickOffers([], "x").offers, []);

assert.equal(cleanTitle("Casque Sony WH-1000XM5 sans fil - Noir | Boulanger"), "Casque Sony WH-1000XM5 sans fil - Noir");
assert.equal(cleanTitle("Wingspan - Philibert", "Philibert"), "Wingspan");
assert.equal(cleanTitle("Casque XM5 - Noir", "Boulanger"), "Casque XM5 - Noir");
assert.deepEqual(tokens("Plaid en laine mérinos"), ["plaid", "laine", "merinos"]);
for (const [i, o] of [["https://www.fnac.com/x", true], ["fnac.com/jbl", true], ["casque sony xm5", false], ["jbl flip 6", false], ["amazon.fr", true]]) assert.equal(looksLikeUrl(i), o, i);
console.log("offers OK");
