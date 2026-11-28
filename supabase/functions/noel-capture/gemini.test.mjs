import assert from "node:assert/strict";
import { extractRequest, lookupRequest, parseExtract, parseLookup, pickLink, searchRequest, searchSources, textOf } from "./gemini.js";

const wrap = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

// Requête de lecture : image en ligne, réponse JSON imposée
const rq = extractRequest("AAAA");
assert.equal(rq.contents[0].parts[0].inline_data.data, "AAAA");
assert.equal(rq.generationConfig.responseMimeType, "application/json");

// Lecture normale
const ok = parseExtract(wrap(JSON.stringify({ title: " Caraco  superposable à bordure en dentelle ", price: 19.95, color: "Bleu marine", size: "M", details: "",
  store: "Hollister", url: "", box: [120, 40, 620, 960], search: "Hollister caraco dentelle", is_product: true })));
assert.equal(ok.title, "Caraco superposable à bordure en dentelle");
assert.equal(ok.price, 19.95);
assert.deepEqual(ok.box, [120, 40, 620, 960]);
assert.equal(ok.url, "");

// Valeurs douteuses écartées : prix négatif ou en texte, adresse non https ou javascript:, cadre hors limites ou minuscule
const bad = parseExtract(wrap("```json\n" + JSON.stringify({ title: "x", price: -3, color: "", size: "", details: "", store: "", url: "javascript:alert(1)",
  box: [0, 0, 1200, 10], search: "", is_product: true }) + "\n```"));
assert.equal(bad.price, null); assert.equal(bad.url, ""); assert.equal(bad.box, null);
assert.equal(parseExtract(wrap(JSON.stringify({ price: "19,95", url: "http://exemple.fr/a", box: [10, 10, 20, 20] }))).price, null);
assert.equal(parseExtract(wrap(JSON.stringify({ url: "http://exemple.fr/a" }))).url, "");
assert.equal(parseExtract(wrap(JSON.stringify({ box: [10, 10, 20, 20] }))).box, null);
assert.equal(parseExtract(wrap("pas du JSON")), null);
assert.equal(parseExtract({}), null);
assert.equal(parseExtract(wrap(JSON.stringify({ is_product: false }))).product, false);
// Les parties « pensée » ne sont pas lues comme réponse
assert.equal(textOf({ candidates: [{ content: { parts: [{ text: "réflexion", thought: true }, { text: "{}" }] } }] }), "{}");

// Recherche : outil google_search
assert.deepEqual(searchRequest({ store: "Hollister", search: "caraco dentelle", title: "" }).tools, [{ google_search: {} }]);

// Sources et choix du lien
const res = wrap("https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319.", {
  groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "hollisterco.com" } },
    { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "idealo.fr" } }] } });
const src = searchSources(res);
assert.deepEqual(src.inText, ["https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319"]);
assert.equal(src.chunks.length, 2);
const resolved = [{ url: "https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319", title: "hollisterco.com" },
  { url: "https://www.idealo.fr/prix/123", title: "idealo.fr" }];
assert.equal(pickLink(src.inText, resolved, "Hollister"), "https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319");
// Adresse du texte sur un site jamais consulté par la recherche : refusée (adresse inventée)
assert.equal(pickLink(["https://faux-site.fr/produit/1"], [{ url: "https://www.idealo.fr/prix/1", title: "idealo.fr" }], ""), "");
// Comparateur seul : rien
assert.equal(pickLink([], [{ url: "https://www.idealo.fr/prix/1", title: "idealo.fr" }], ""), "");
// Le site du magasin vu sur la capture passe devant
assert.equal(pickLink([], [{ url: "https://www.zalando.fr/hollister-caraco/abc", title: "zalando.fr" },
  { url: "https://www.hollisterco.com/shop/p/caraco", title: "hollisterco.com" }], "Hollister"), "https://www.hollisterco.com/shop/p/caraco");
// Page d'accueil seule : écartée
assert.equal(pickLink([], [{ url: "https://www.hollisterco.com/", title: "hollisterco.com" }], "Hollister"), "");
// Lien collé : recherche Google du produit
assert.deepEqual(lookupRequest("https://www.hollisterco.com/p/x", "Lace trim").tools, [{ google_search: {} }]);
const src1 = { groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/x", title: "hollisterco.com" } }] } };
const lk = parseLookup(wrap('Voici : {"title":"Caraco à bordure en dentelle","price":19.95,"image":"https://img.hollisterco.com/p.jpg","found":true}', src1));
assert.deepEqual(lk, { title: "Caraco à bordure en dentelle", price: 19.95, image: "https://img.hollisterco.com/p.jpg" });
// Aucune source consultée (réponse « de mémoire ») : rien
assert.equal(parseLookup(wrap('{"title":"x","price":10,"image":"","found":true}')), null);
// Produit pas trouvé : rien
assert.equal(parseLookup(wrap('{"title":"x","price":10,"image":"","found":false}', src1)), null);
// Prix et image douteux écartés
assert.deepEqual(parseLookup(wrap('{"title":"x","price":"10 €","image":"http://a.fr/i.jpg","found":true}', src1)), { title: "x", price: null, image: "" });
console.log("gemini.test.mjs : OK");
