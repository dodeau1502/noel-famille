import assert from "node:assert/strict";
import { productRef, catalogRequest, infoFromCatalog } from "./shopify.js";
import { applyPage } from "./verify.js";

// Formes de liens
assert.deepEqual(productRef("https://www.mello-matelas.fr/products/surmatelas-duo?variant=231"), { origin: "https://www.mello-matelas.fr", handle: "surmatelas-duo", variant: "231" });
assert.equal(productRef("https://seatosummit.eu/fr-fr/products/aeros").handle, "aeros");
assert.equal(productRef("https://www.greige.fr/products/parure-coton/greige").handle, "parure-coton");
assert.equal(productRef("https://x.fr/collections/lit/products/drap").handle, "drap");
assert.equal(productRef("https://www.amazon.fr/dp/B000"), null);
assert.equal(productRef("http://x.fr/products/drap"), null);

assert.equal(catalogRequest(productRef("https://x.fr/products/a-b?variant=7"), "p").params.name, "lookup_catalog");
assert.equal(catalogRequest(productRef("https://x.fr/products/a-b"), "p").params.arguments.catalog.query, "a b");

const V = (id, amount, available = true) => ({ id: "gid://shopify/ProductVariant/" + id, price: { amount, currency: "EUR" }, availability: { available } });
const rpc = (variants, min, max, handle = "drap") => ({ result: { structuredContent: { products: [
  { handle: "autre", title: "Autre", variants: [V(9, 100)], price_range: { min: { amount: 100, currency: "EUR" }, max: { amount: 100, currency: "EUR" } } },
  { handle, title: "Drap de bain", variants, price_range: { min: { amount: min, currency: "EUR" }, max: { amount: max, currency: "EUR" } } },
] } } });
const ref = productRef("https://x.fr/products/drap");

// Plusieurs prix : le prix connu est confirmé s'il est l'un d'eux, sinon rien n'est affirmé
const multi = infoFromCatalog(rpc([V(1, 4000), V(2, 5500)], 4000, 5500), ref);
assert.equal(multi.price, 40);
assert.equal(applyPage({ price: 55 }, multi, "Drap de bain").verified, true);
assert.equal(applyPage({ price: 55 }, multi, "Drap de bain").price, 55);
assert.equal(applyPage({ price: 50 }, multi, "Drap de bain").verified, false);

// Variante désignée par le lien : son prix, son stock
const one = infoFromCatalog(rpc([V(231, 25990, false)], 18990, 33990), { ...ref, variant: "231" });
assert.deepEqual([one.price, one.stock, one.prices], [259.9, "out", 1]);
// Remise affichée par le site mais absente du catalogue : le prix remisé n'est pas écrasé
const promo = applyPage({ price: 207.92 }, one, "Drap de bain");
assert.deepEqual([promo.price, promo.verified], [207.92, false]);
assert.equal(applyPage({ price: 300 }, one, "Drap de bain").price, 259.9);   // une baisse du catalogue reste prise

// Absent, autre devise, réponse illisible : rien
assert.equal(infoFromCatalog(rpc([V(1, 4000)], 4000, 4000, "pas-le-bon"), ref), null);
assert.equal(infoFromCatalog(rpc([V(1, 4000)], 4000, 4000), { ...ref, variant: "999" }), null);
assert.equal(infoFromCatalog({ error: { code: -32001 } }, ref), null);
const usd = rpc([V(1, 4000)], 4000, 4000); usd.result.structuredContent.products[1].price_range.min.currency = "USD";
assert.equal(infoFromCatalog(usd, ref), null);
console.log("shopify OK");
