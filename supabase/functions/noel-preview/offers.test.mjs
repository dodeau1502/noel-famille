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


// --- v6 : accessoires, vendeurs tiers, comparateurs, fiche produit Google ---
// Données modelées sur les résultats réels observés (Osmo Pocket 3, Switch 2, Faucon Millenium, XM5)
import { isAccessory, isComparator, pickProduct, matchesLoose, storesToOffers, mergeOffers } from "./offers.js";
const QO = "DJI Osmo Pocket 3 Creator Combo";
for (const [t, e] of [
  ["DJI Osmo Pocket 3 Creator Combo", false],
  ["Coque de protection pour DJI Osmo Pocket 3 Creator Combo", true],
  ["Verre trempé DJI Osmo Pocket 3 Creator Combo", true],
  ["Support de fixation DJI Osmo Pocket 3 Creator Combo", true],
  ["DJI Osmo Pocket 3 Creator Combo + carte 128 Go", true],
  ["Étui compatible DJI Osmo Pocket 3 Creator Combo", true],
]) assert.equal(isAccessory(t, QO), e, t);
assert.equal(isAccessory("Manette Xbox sans fil", "Manette Xbox"), false);            // le mot est dans la requête
assert.equal(isAccessory("Manette Pro pour Nintendo Switch 2", "Nintendo Switch 2"), true);
assert.equal(isAccessory("LEGO Star Wars 75192 Faucon Millenium", "LEGO Star Wars 75192 Faucon Millenium"), false);
assert.equal(isAccessory("Vitrine pour LEGO 75192 Faucon Millenium", "LEGO Star Wars 75192 Faucon Millenium"), true);
for (const [s, u, e] of [["Amazon.fr - Seller","",true],["Ubuy France","",true],["OnBuy","",true],["Beebs","",true],["achatmoinscher","",true],["Kulturegeek","",true],["idealo","https://www.idealo.fr/x",true],["E.Leclerc Marketplace","",true],["Amazon.fr","",false],["LDLC","",false],["TopAchat","",false],["Boulanger","",false],["DJI Store","",false]]) assert.equal(isMarketplace(s, u), e, s);
assert.ok(isComparator("Kelkoo", "") && !isComparator("LDLC", ""));

// Les accessoires ne faussent plus le meilleur prix (cas réel : coque à 19 € « meilleure offre » de l'Osmo)
const osmoFlat = [
  R(QO, "Cdiscount", 439), R(QO, "DJI Store", 439), R(QO, "Fnac", 449), R(QO, "Amazon.fr - Seller", 389),
  R("Coque silicone pour " + QO, "Beebs", 12), R("Pare-soleil " + QO + " + filtre", "Ubuy", 25),
];
const op = pickOffers(osmoFlat, QO);
assert.deepEqual(op.offers.map(o => o.store).sort(), ["Cdiscount", "DJI Store", "Fnac"]);

// Choix de la fiche produit Google : jeton le plus fréquent parmi les résultats corrects
const T = (title, price, tok, extra = {}) => R(title, "S" + price, price, { immersive_product_page_token: tok, ...extra });
const prod = pickProduct([
  T("Support " + QO, 15, "tokAcc"), T(QO, 439, "tokOk"), T(QO + " noir", 440, "tokOk"), T(QO, 441, "tokOther"),
  T(QO + " reconditionné", 300, "tokUsed"), T("DJI Osmo Pocket 3 Standard", 349, "tokStd"),
], QO);
assert.equal(prod.token, "tokOk"); assert.ok(prod.image.startsWith("https://"));
assert.equal(pickProduct([T("Housse pour " + QO, 10, "a")], QO), null);
assert.equal(pickProduct([R(QO, "Fnac", 449)], QO).token, "");                  // pas de jeton : repli sur la liste

// Marchands de la fiche produit (formats observés chez SerpAPI) ; le titre erroné d'un catalogue est écarté
const stores = [
  { name: "Boulanger", link: "https://www.boulanger.com/x", title: "Sèche-linge Beko 8 kg", extracted_price: 416.99 },   // erreur de catalogue
  { name: "E.Leclerc Marketplace", link: "/goto?url=AAA", title: QO, extracted_price: 416.3 },                         // place de marché
  { name: "Veepee", link: "/goto?url=BBB", title: QO, extracted_price: 416.99, shipping: "Livraison gratuite" },
  { name: "Galeries Lafayette", link: "/goto?url=CCC", title: "DJI Osmo Pocket 3 Creator Combo - Gris", extracted_price: 416.99, shipping: "+ 3,99 €" },
  { name: "Electro Dépôt", link: "https://www.electrodepot.fr/p", title: QO, extracted_price: 438.9, extracted_total: 438.9 },
  { name: "Kulturegeek", link: "https://kulturegeek.fr/x", title: QO, extracted_price: 400 },                         // comparateur
  { name: "Darty", link: "https://www.darty.com/y", title: QO + " reconditionné", extracted_price: 300 },              // occasion
  { name: "Sans prix", link: "https://x.fr", title: QO },
];
const so = storesToOffers(stores, QO);
assert.deepEqual(so.map(o => o.store), ["Veepee", "Galeries Lafayette", "Electro Dépôt"]);
assert.equal(so[0].url, "https://www.google.fr/goto?url=BBB");
assert.equal(so[0].shipping, 0); assert.equal(so[1].shipping, 3.99); assert.equal(so[2].shipping, null);
assert.ok(so.every(o => o.via === "google"));
// livraison déduite du total quand elle n'est pas détaillée
assert.equal(storesToOffers([{ name: "A", link: "https://a.fr/p", title: QO, extracted_price: 100, extracted_total: 105.9 }], QO)[0].shipping, 5.9);
assert.ok(matchesLoose("Sony WH-1000XM5", "Casque Bluetooth Sony WH-1000XM5 noir"));
assert.ok(!matchesLoose("Sony WH-1000XM5", "Sony WH-1000XM4"));
assert.ok(!matchesLoose("DJI Osmo Action 6", "DJI Osmo Action 6 Pro"));

// Fusion : une offre par marchand, la moins chère ; à prix égal, la vérifiée
const mg = mergeOffers(
  [{ store: "LDLC", price: 300, url: "https://a", shipping: null }, { store: "Fnac", price: 320, url: "https://b" }],
  [{ store: "ldlc", price: 300, url: "https://c", verified: true }, { store: "Darty", price: 0, url: "https://d" }],
);
assert.deepEqual(mg.map(o => o.store).sort(), ["Fnac", "ldlc"]); assert.equal(mg.find(o => o.store === "ldlc").verified, true);


// --- Produit ambigu : « Nintendo Switch 2 » ne doit pas devenir un jeu (cas réel : Mario Kart choisi, offres à 40 €) ---
import { dropOutliers } from "./offers.js";
const QS = "Nintendo Switch 2";
const sw = [
  ...[39, 44, 46, 56, 60].map((p, i) => T("Mario Kart World Nintendo Switch 2", p, "tokGame")),
  T("Console Nintendo Switch 2", 449, "tokConsole"),
  T("Nintendo Switch 2 Pack Mario Kart", 509, "tokPack"),
];
const ps = pickProduct(sw, QS);
assert.equal(ps.token, "tokConsole");
assert.deepEqual(ps.alternatives.map(a => a.token), ["tokConsole"]);   // ni le jeu à 40-60 €, ni le lot « pack » (autre version) ne sont proposés
assert.equal(ps.rows.length, 1);   // seules les lignes de la fiche choisie servent de repli
// Un prix très inférieur aux autres est écarté (cas réel : boutique d'étuis à 30,95 € pour un casque à 250 €)
const dz = dropOutliers([{ store: "lux-case.fr", price: 30.95 }, { store: "Amazon.fr", price: 249.99 }, { store: "Sony", price: 249.99 }]);
assert.deepEqual(dz.map(o => o.store), ["Amazon.fr", "Sony"]);
assert.equal(dropOutliers([{ store: "A", price: 10 }, { store: "B", price: 200 }]).length, 2);          // deux offres : pas de verdict
assert.equal(dropOutliers([{ store: "P", price: 500, via: "page" }, { store: "A", price: 250 }, { store: "B", price: 250 }]).length, 3);


// --- Cas réels : référence collée, faute d'une lettre, titres commerciaux longs ---
assert.ok(matchesLoose("Sony WH-1000XM5", "Sony WH1000XM5 bleu nuit Casque audio"));                      // Darty : « WH1000XM5 » collé
assert.ok(!matchesLoose("Sony WH-1000XM5", "Sony WH1000XM4 casque"));
assert.ok(!matchesLoose("Sony WH-1000XM5", "Sony WH-1000XM50 casque"));
assert.equal(pickOffers([R("Sony WH1000XM5 casque", "Darty", 249.99)], "Sony WH-1000XM5").offers.length, 1);
assert.equal(pickOffers([R("LEGO® Star Wars™ Faucon Millennium 75192", "LEGO", 849.99)], "LEGO Star Wars 75192 Faucon Millenium").offers.length, 1);  // Millennium / Millenium
assert.equal(pickOffers([R("LEGO Star Wars 75193 Faucon Millenium", "LEGO", 849.99)], "LEGO Star Wars 75192 Faucon Millenium").offers.length, 0);
assert.equal(pickOffers([R("Coussin Star", "X", 9)], "LEGO Star Wars 75192 Faucon Millenium").offers.length, 0);
// Marchands d'une fiche Google : le titre commercial peut contenir « pack » ou « édition » (Boulanger/Switch 2), pas une autre référence
const st2 = storesToOffers([
  { name: "Boulanger", link: "/goto?url=ZZ", title: "NINTENDO Switch 2 | Console de jeu portable | mémoire 256 Go | Édition spéciale", extracted_price: 469.99, shipping: "Gratuit" },
  { name: "Autre", link: "https://a.fr/p", title: "Sèche-linge Beko 8 kg", extracted_price: 416.99 },
  { name: "Darty.com", link: "/goto?url=YY", title: "Console Nintendo Switch 2", extracted_price: 449, shipping: "Gratuit" },
  { name: "Cdiscount", link: "/goto?url=XX", title: "Console Nintendo Switch 2", extracted_price: 449, shipping: "+ 39,99 €" },
], QS);
assert.deepEqual(st2.map(o => o.store).sort(), ["Boulanger", "Cdiscount", "Darty.com"]);
// Les propositions alternatives restent dans une fourchette de prix comparable (pas de manette à 75 € pour une console à 424 €)
const alt = pickProduct([T("Console Nintendo Switch 2", 424, "a"), T("Console Nintendo Switch 2 Mario Kart World", 660, "b"), T("Nintendo Switch 2 Orbitals", 56, "c")], QS);
assert.deepEqual(alt.alternatives.map(a => a.token), ["a", "b"]);


// Référence numérique longue : la marque et la référence suffisent (« Faucon » / « Falcon », « Millenium » / « Millennium »)
assert.equal(pickOffers([R("LEGO Millennium Falcon Set 75192", "Fnac", 849)], "LEGO Star Wars 75192 Faucon Millenium").offers.length, 1);
assert.equal(pickOffers([R("LEGO Set 75257", "Fnac", 849)], "LEGO Star Wars 75192 Faucon Millenium").offers.length, 0);
for (const m of ["Brick Owl", "StockX", "BrickLink", "Made-in-China.com"]) assert.ok(isMarketplace(m, ""), m);
// Titres commerciaux longs mentionnant des manettes : l'offre d'une fiche Google n'est pas un accessoire
assert.equal(storesToOffers([{ name: "Boulanger", link: "/goto?url=Q", title: "NINTENDO Switch 2 | Console de jeu portable | avec manettes Joy-Con 2", extracted_price: 469.99 }], QS).length, 1);
// Plusieurs vendeurs du même produit ne forment pas des alternatives ; deux produits différents oui
const same = pickProduct([T("Sony Casque sans fil WH-1000XM5", 250, "a"), T("Casque Sony wh 1000XM5", 170, "b"), T("Sony WH-1000XM5", 220, "c")], "Sony WH-1000XM5");
assert.equal(same.alternatives.length, 1);
console.log("offers OK");
