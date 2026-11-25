// node supabase/functions/noel-radar/dealabs.test.mjs : lecture du flux, sur le fichier de test (jamais sur dealabs.com)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseFeed, extractFacts, itemId, cleanLink, pad14 } from "./dealabs.js";

const xml = readFileSync(new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url), "utf8");
const { items, self } = parseFeed(xml);
const by = s => items.find(i => i.title.includes(s));

assert.equal(self, "https://www.dealabs.com/rss/tous");
assert.equal(items.length, 30);
assert.ok(items.every(i => i.pubDate instanceof Date && !isNaN(i.pubDate)));

// Premier élément
assert.equal(items[0].merchant, "Bax Music");
assert.equal(items[0].price, 91);
assert.equal(items[0].category, "Culture & Divertissement");
assert.equal(itemId(items[0]), "3469432");

// Marchand ou prix manquants : jamais déduits du titre
assert.equal(by("Zooparc").merchant, null);
assert.equal(by("Zooparc").price, 26);
assert.equal(by("Abonnement Prime").price, null);
assert.equal(by("Sweat").merchant, "Pull&Bear");
assert.equal(by("Sweat").price, null);
assert.equal(by("Lenovo").price, 1299);

// Faits
let f = extractFacts(by("Philips"));
assert.deepEqual(f.asins, ["B0DQQBGNV4"]);
assert.deepEqual(f.links, ["https://www.amazon.fr/dp/B0DQQBGNV4"]);
assert.equal(f.ref30, 14.91);

f = extractFacts(by("DJ SET"));
assert.deepEqual(f.asins, ["B0FVFCHC3W"]);
assert.deepEqual(f.gtins, ["03770022054332"]);

f = extractFacts(by("Carrera Yoshi"));
assert.deepEqual(f.asins, ["B08Q3GLFXP"]);
assert.deepEqual(f.gtins, ["09003150122609"]);
assert.ok(f.mpns.includes("370200997X"), "MPN Mario Kart");

f = extractFacts(by("PcComponentes") || by("RTX 4070"));
assert.deepEqual(f.links, ["https://www.pccomponentes.fr/msi-rtx-4070-super"]);
assert.ok(!f.links.join().includes("awc") && !f.links.join().includes("sv1"));

f = extractFacts(by("Silent Hill"));
assert.ok(f.links.length === 1 && !f.links[0].includes("curator_clanid") && !f.links[0].includes("utm_"));

f = extractFacts(by("Cooler Master"));
assert.ok(f.mpns.includes("MPX-8503-AFAG-2EBEU") && f.mpns.includes("MPX8503AFAG2EBEU"), "MPN Cooler Master " + f.mpns);
f = extractFacts(by("Violon"));
assert.ok(f.mpns.includes("9000-0007-4142"), "MPN violon (la fin de ligne coupe la valeur) " + f.mpns);
assert.ok(!f.mpns.some(m => /Voir|Bax/.test(m)));

f = extractFacts(by("TTArtisan"));
assert.equal(f.soldBy, "Photo Discount Boutique en ligne");

// Liens : jamais Dealabs, /visit/, liens courts ni affiliation
assert.equal(cleanLink("https://www.dealabs.com/visit/thread/123"), null);
assert.equal(cleanLink("https://www.dealabs.com/bons-plans/x-1"), null);
assert.equal(cleanLink("https://amzn.to/abc"), null);
assert.equal(cleanLink("https://www.awin1.com/cread.php?ued=https%3A%2F%2Fx.fr"), null);
assert.equal(cleanLink("http://www.fnac.com/a1"), null, "pas de lien http");
assert.equal(cleanLink("https://www.amazon.fr/Quelque-Titre/dp/B0DQQBGNV4/ref=sr_1_1?tag=x"), "https://www.amazon.fr/dp/B0DQQBGNV4");
assert.equal(cleanLink("https://www.amazon.de/dp/B0DQQBGNV4"), null);
assert.equal(cleanLink("https://www.amazon.fr/s?k=truc"), null, "Amazon sans ASIN");
assert.equal(cleanLink("https://www.boulanger.com/ref/123?utm_source=a&awc=1&color=noir#top"), "https://www.boulanger.com/ref/123?color=noir");
assert.equal(pad14("3770022054332"), "03770022054332");

// Robustesse
assert.deepEqual(parseFeed("").items, []);
assert.deepEqual(parseFeed(null).items, []);
assert.deepEqual(parseFeed("<rss><channel><item><title>coupé").items, []);
assert.deepEqual(parseFeed("x".repeat(2_000_001)).items, []);
assert.equal(parseFeed(xml.slice(0, 3000)).items.length >= 0, true);
assert.deepEqual(parseFeed("<rss>" + "<item><title>a</title><guid>g</guid><pubDate>Wed, 25 Nov 2026 19:58:00 +0000</pubDate></item>".repeat(201) + "</rss>").items, []);

console.log("dealabs OK");
