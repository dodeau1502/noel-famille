import assert from "node:assert/strict";
import { pickOffers, cleanTitle, looksLikeUrl, tokens, isMarketplace, shippingCost, totalOf } from "./offers.js";

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
import { betterTitle } from "./offers.js";
assert.equal(betterTitle("Drone Dji Lito X1", "Controleur de vol avec capteur de proximité pour drone DJI Lito X1", "reparation-drone.com"), "Controleur de vol avec capteur de proximité pour drone DJI Lito X1");
assert.equal(betterTitle("Casque Sony XM5", "Autre produit"), "Casque Sony XM5");
assert.equal(betterTitle("", "Titre H1"), "Titre H1");

// --- Règles de fiabilité (v4) ---
const Q = "DJI Osmo Action 6 Adventure Combo";
const osmo = [
  R("DJI Osmo Action 6 Adventure Combo", "Leboncoin", 330),                         // place de marché
  R("DJI Osmo Action 6 Adventure Combo", "foto-erhardtfr", 300),                    // identifiant de vendeur
  R("DJI Osmo Action 6 Adventure Combo", "Revendeur", 310, { link: "https://www.ebay.fr/itm/1" }), // lien eBay
  R("DJI Osmo Action 6 Adventure Combo reconditionné", "Boulanger", 250),           // occasion/reconditionné
  R("DJI Osmo Action 6 Adventure Combo", "Fnac", 280, { second_hand_condition: "Occasion" }),
  R("DJI Osmo Action 6 Standard Combo", "Microless", 299),                          // autre version
  R("DJI Osmo Action 6 Combo Aventure", "Darty", 300),                              // mot-clé « adventure » absent
  R("DJI Osmo Action 5 Adventure Combo", "Amazon.fr", 320),                         // autre génération
  R("DJI Osmo Action 6 Adventure Combo", "Micromania", 399, { delivery: "+ 5,99 € de livraison" }),
  R("DJI Osmo Action 6 Adventure Combo", "DJI Official Store", 436, { delivery: "Livraison gratuite" }),
  R("DJI Osmo Action 6 Adventure Combo", "Cdiscount", 420, { delivery: "Livraison gratuite dès 50 €" }),
];
const o6 = pickOffers(osmo, Q);
assert.deepEqual(o6.offers.map(o => o.store), ["Micromania", "Cdiscount", "DJI Official Store"]);
assert.equal(o6.offers[0].shipping, 5.99);
assert.equal(o6.offers[2].shipping, 0);
assert.equal(o6.offers[1].shipping, null); // livraison gratuite sous condition : inconnue

// Le classement tient compte de la livraison
const ship = pickOffers([
  R("Sony WH-1000XM5 casque", "A", 300, { delivery: "+ 25 € de livraison" }),
  R("Sony WH-1000XM5 casque", "B", 310, { delivery: "Livraison gratuite" }),
  R("Sony WH-1000XM5 casque", "C", 320, { delivery: "Livraison gratuite" }),
], "Casque Sony WH-1000XM5");
assert.deepEqual(ship.offers.map(o => o.store), ["B", "C", "A"]);
assert.equal(totalOf(ship.offers[2]), 325);

// Prix suspect (trop bas par rapport aux autres) écarté quand on a au moins 3 prix
const sus = pickOffers([
  R("Sony WH-1000XM5 casque", "A", 299), R("Sony WH-1000XM5 casque", "B", 310), R("Sony WH-1000XM5 casque", "C", 320),
  R("Sony WH-1000XM5 casque", "D", 99),
], "Casque Sony WH-1000XM5");
assert.ok(!sus.offers.some(o => o.store === "D"));

// Couleur non exigée ; version « Pro » différente de la version de base
assert.equal(pickOffers([R("Sony WH-1000XM5 casque", "Fnac", 349)], "Casque Sony WH-1000XM5 Noir").offers.length, 1);
assert.equal(pickOffers([R("Sony WH-1000XM5 Pro casque", "Fnac", 349)], "Casque Sony WH-1000XM5").offers.length, 0);
// Si la requête demande de l'occasion, on ne l'écarte pas
assert.equal(pickOffers([R("Sony WH-1000XM5 casque occasion", "Fnac", 200)], "Casque Sony WH-1000XM5 occasion").offers.length, 1);
for (const [s, u, e] of [["Leboncoin","",true],["eBay","",true],["Back Market","",true],["Vinted","",true],["foto-erhardtfr","",true],["Boulanger","",false],["Amazon.fr","",false],["Top Achat","",false],["X","https://www.ebay.fr/itm/1",true]]) assert.equal(isMarketplace(s, u), e, s);
for (const [d, e] of [["Livraison gratuite",0],["+ 5,99 € de livraison",5.99],["Livraison gratuite dès 50 €",null],[undefined,null]]) assert.equal(shippingCost({ delivery: d }), e, String(d));
assert.deepEqual(tokens("Osmo Action 6 a"), ["osmo","action","6"]);
console.log("offers OK");
