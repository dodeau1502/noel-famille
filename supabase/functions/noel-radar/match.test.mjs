// node supabase/functions/noel-radar/match.test.mjs : rapprochement des deals avec des cadeaux fictifs (fichier de test, jamais dealabs.com)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseFeed, factOf } from "./dealabs.js";
import { matchGift, matchAll, excluded, modelPart, mpnKey, titleKey } from "./match.js";

const { items } = parseFeed(readFileSync(new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url), "utf8"));
const facts = items.map(factOf);
const fact = s => facts.find(f => f.title.includes(s));
let n = 0;
const gift = o => ({ id: ++n, title: "", variant: null, gtin: null, asin: null, mpn: null, aliases: [], url: null, offers: [], price: null, ...o });
const lvl = (g, deal) => matchGift(g, fact(deal)).level;

// --- Niveaux ----------------------------------------------------------------------------------------------
assert.equal(lvl(gift({ title: "Montre Garmin vivoactive 5" }), "Garmin"), "strict");
assert.equal(lvl(gift({ title: "Garmin vivoactive 6" }), "Garmin"), null);
assert.equal(lvl(gift({ title: "Garmin Venu 3" }), "Garmin"), null);
for (const gtin of ["3770022054332", "03770022054332"]) assert.equal(lvl(gift({ title: "Jeu DJ SET", gtin }), "DJ SET"), "exact", "GTIN " + gtin);
assert.equal(matchGift(gift({ title: "Autre nom", gtin: "3770022054332" }), fact("DJ SET")).level, "exact", "le GTIN suffit même si le titre diffère");
assert.equal(lvl(gift({ title: "Cadeau sans rapport", asin: "B08Q3GLFXP" }), "Yoshi"), "exact", "ASIN");
assert.equal(lvl(gift({ title: "Cadeau sans rapport", url: "https://www.amazon.fr/Titre/dp/B08Q3GLFXP/ref=x?tag=y" }), "Yoshi"), "exact", "ASIN tiré de l'adresse du cadeau");
assert.equal(lvl(gift({ title: "Cadeau sans rapport", offers: [{ store: "Amazon", price: 50, url: "https://www.amazon.fr/dp/B08Q3GLFXP" }] }), "Yoshi"), "exact", "ASIN d'une offre Amazon");
assert.equal(lvl(gift({ title: "Cadeau sans rapport", url: "https://www.pccomponentes.fr/msi-rtx-4070-super?utm=1" }), "RTX 4070"), "exact", "lien identique");
assert.equal(lvl(gift({ title: "Voiture RC Mario Kart Mario Carrera" }), "Yoshi"), "loose");

// --- Version : la partie « modèle » du titre -----------------------------------------------------------------
const deebot = gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 249 }] });
assert.equal(lvl(deebot, "Ecovacs"), "strict", "« Ultra-fin » après le tiret n'est pas une version");
assert.equal(modelPart("Robot aspirateur laveur Ecovacs Deebot T50 Omni Gen 2 - 21 000 Pa, Station OMNI…, Ultra-fin 8,1 cm"), "Robot aspirateur laveur Ecovacs Deebot T50 Omni Gen 2");
assert.equal(modelPart("[Prime] Objectif TTArtisan 75mm (Vendeur Tiers)"), "Objectif TTArtisan 75mm");
assert.equal(modelPart("Casque Sony WH-1000XM5 - Édition limitée"), "Casque Sony WH-1000XM5");
assert.equal(modelPart("Sony - Casque, noir"), "Sony - Casque, noir".split(",")[0], "un seul mot avant le tiret : on continue jusqu'à la virgule");
assert.equal(matchGift(gift({ title: "Ecovacs Deebot T50 Omni" }), { title: "Robot Ecovacs Deebot T50 Pro Omni - 18 000 Pa" }).level, null, "« pro » dans la partie modèle");
// Choix documenté : « Édition limitée » est APRÈS le tiret, donc hors de la partie modèle : le deal est accepté.
assert.equal(matchGift(gift({ title: "Sony WH-1000XM5" }), { title: "Casque Sony WH-1000XM5 - Édition limitée" }).level, "strict");
// …mais « edition » dans la partie modèle est une autre version.
assert.equal(matchGift(gift({ title: "Sony WH-1000XM5" }), { title: "Casque Sony WH-1000XM5 Edition limitée - noir" }).level, null);

// --- Exclusions ------------------------------------------------------------------------------------------
const skipped = [];
const run = (gifts, deal) => matchAll(gifts, [fact(deal)], { onSkip: (g, f, why) => skipped.push(why) });
skipped.length = 0;
assert.equal(run([gift({ title: "Ryzen 7 7800X3D" })], "7800X3D").length, 0);
assert.equal(skipped.pop(), "place de marché");
assert.equal(run([gift({ title: "Climatiseur Daikin FTXC35D" })], "Daikin").length, 0);
assert.equal(skipped.pop(), "place de marché");
assert.equal(run([gift({ title: "Objectif TTArtisan 75mm f1.5 M42" })], "TTArtisan").length, 0);
assert.equal(skipped.pop(), "vendeur tiers");

// Pas moins cher : Cdiscount à 229 €
let r = run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 249 }] })], "Ecovacs");
assert.equal(r.length, 1); assert.equal(r[0].level, "strict"); assert.deepEqual(r[0].extra, []);
assert.equal(run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 199 }] })], "Ecovacs").length, 0);
assert.equal(skipped.pop(), "pas moins cher");
assert.equal(run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 199, shipping: 40 }] })], "Ecovacs").length, 1, "livraison comprise : 239 € > 229 €");
assert.equal(run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2" })], "Ecovacs").length, 1, "cadeau sans prix : jamais exclu");
// Un prix en rupture ne compte pas comme meilleur prix
assert.equal(run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 199, stock: "out" }, { store: "Y", price: 300 }] })], "Ecovacs").length, 1);
// Prix suspect : gardé avec une condition « Prudence »
r = run([gift({ title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 700 }] })], "Ecovacs");
assert.equal(r.length, 1); assert.equal(r[0].extra[0].type, "prudence");

assert.equal(excluded({ title: "Casque Sony WH-1000XM5 reconditionné", merchant: "Boulanger", price: 100, links: [] }, gift({ title: "Casque Sony WH-1000XM5" })), "occasion");
assert.equal(excluded({ title: "Coque pour Sony WH-1000XM5", merchant: "Boulanger", price: 10, links: [] }, gift({ title: "Casque Sony WH-1000XM5" })), "accessoire");
assert.equal(excluded({ title: "Casque Sony", merchant: "idealo", price: 10, links: [] }, gift({ title: "Casque Sony" })), "comparateur");
assert.equal(excluded({ title: "Casque Sony", merchant: "Fnac", price: 10, links: [] }, gift({ title: "Casque Sony" })), null);

// Un « Non » du propriétaire ne se reproduit pas pour le même titre de deal
const g = gift({ title: "Voiture RC Mario Kart Mario Carrera" });
const rej = new Set([`${g.id}|${titleKey(fact("Yoshi").title)}`]);
assert.equal(matchAll([g], [fact("Yoshi")], { rejected: rej, onSkip: (_, __, w) => skipped.push(w) }).length, 0);
assert.equal(skipped.pop(), "refusé par le propriétaire");
assert.equal(matchAll([g], [fact("Yoshi")]).length, 1);

// --- Référence constructeur (MPN) -----------------------------------------------------------------------------
const cm = t => gift({ title: "Alimentation Cooler Master MWE Gold 850W V3", mpn: t });
assert.equal(matchGift(cm("MPX-8503-AFAG-2EBEU"), fact("Cooler Master")).reason, "référence constructeur");
assert.equal(matchGift(cm("MPX-8503-AFAG-2EBEU"), fact("Cooler Master")).level, "exact");
assert.notEqual(matchGift(cm("MPX-8503-AFAG-2EBEX"), fact("Cooler Master")).level, "exact", "référence différente : pas exact (le strict peut s'appliquer)");
assert.equal(matchGift(gift({ title: "Yamaha Silent Violin", mpn: "9000-0007-4142" }), fact("Violon")).level, null, "marque absente du titre du deal");
assert.equal(matchGift(gift({ title: "Stagg violon", mpn: "9000-0007-4142" }), fact("Violon")).level, "exact", "marque présente");
assert.equal(mpnKey("3770022054332"), "", "forme de code-barres");
assert.equal(mpnKey("AB12"), "", "trop court");
assert.equal(mpnKey("ABCDEFG"), "", "aucun chiffre");
assert.equal(mpnKey("MPX-8503-AFAG-2EBEU"), "MPX8503AFAG2EBEU");

// --- Bruit : des cadeaux sans rapport ne correspondent à aucun des 30 deals ---------------------------------------
const noise = ["Casque Sony WH-1000XM5", "Appareil photo Fujifilm X-T5", "Lego Star Wars Faucon Millenium", "Manette Xbox Elite", "Drone DJI Mini 4 Pro",
  "Kindle Paperwhite", "Aspirateur Dyson V15", "Machine à café Delonghi Magnifica", "Enceinte JBL Flip 6"].map(title => gift({ title }));
assert.equal(matchAll(noise, facts).length, 0, "aucune correspondance pour 9 cadeaux sans rapport");
console.log("match OK");
