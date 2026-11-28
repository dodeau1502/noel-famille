import { extract, parsePrice, isPrivateIp, badHostname } from './parse.js';
import assert from 'node:assert/strict';
const a = `<html><head><title>Fallback</title>
<meta property="og:title" content="Casque Sony WH-1000XM5 &amp; étui">
<meta property="og:image" content="/img/xm5.jpg"><meta property="og:site_name" content="Boulanger">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X","offers":{"@type":"Offer","price":"329,00","priceCurrency":"EUR"}}</script></head></html>`;
let r = extract(a, "https://www.boulanger.com/ref/123");
assert.equal(r.title, "Casque Sony WH-1000XM5 & étui");
assert.equal(r.image, "https://www.boulanger.com/img/xm5.jpg");
assert.equal(r.price, 329); assert.equal(r.store, "Boulanger");
const b = `<meta content="49.90" property="product:price:amount"><meta content="EUR" property="product:price:currency"><meta property="og:image" content="http://insecure/x.jpg">`;
r = extract(b, "https://shop.fr/p"); assert.equal(r.price, 49.9); assert.equal(r.image, ""); assert.equal(r.store, "shop.fr");
const c = `<script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Lampe","image":["https://x.fr/1.jpg"],"offers":{"@type":"AggregateOffer","lowPrice":19.99,"priceCurrency":"USD"}}]</script>`;
r = extract(c, "https://x.fr/l"); assert.equal(r.price, null); assert.equal(r.image, "https://x.fr/1.jpg"); assert.equal(r.title, "Lampe");
for (const [i,o] of [["1 299,99",1299.99],["1.299,99",1299.99],["1,299.99",1299.99],["19,90 €",19.9],["12",12],["1.299",1299],["abc",null]]) assert.equal(parsePrice(i), o, i);
assert.ok(isPrivateIp("10.0.0.5")&&isPrivateIp("127.0.0.1")&&isPrivateIp("169.254.169.254")&&isPrivateIp("192.168.1.1")&&isPrivateIp("::1"));
assert.ok(!isPrivateIp("93.184.216.34"));
assert.ok(badHostname("localhost")&&badHostname("192.168.0.1")&&badHostname("intranet")&&badHostname("x.internal")&&!badHostname("www.amazon.fr"));
// Amazon : ni og:image ni JSON-LD, la photo principale porte id="landingImage" (balise avec un « > » dans un attribut)
const amz = `<title>Liseuse</title><img src="https://m.example/other.jpg"><img alt="x" src="https://m.example/small.jpg" data-old-hires="https://m.example/big.jpg" onload="if(a > 1){}" class="c" id="landingImage" data-a-dynamic-image="{&quot;https://m.example/mid.jpg&quot;:[355,355]}">`;
assert.equal(extract(amz, "https://www.amazon.fr/dp/X").image, "https://m.example/big.jpg");
assert.equal(extract(amz.replace("https://m.example/big.jpg", ""), "https://www.amazon.fr/dp/X").image, "https://m.example/mid.jpg");
assert.equal(extract(`<link rel="image_src" href="/p.jpg">`, "https://shop.fr/a").image, "https://shop.fr/p.jpg");
assert.equal(extract(`<img src="https://m.example/other.jpg">`, "https://shop.fr/a").image, "");
console.log("parse OK");
// --- v6 : code-barres, stock ---
import { cleanGtin, findStock } from './parse.js';
const d = `<script type="application/ld+json">{"@type":"Product","name":"Sony WH-1000XM5","gtin13":"4548736132580","offers":{"@type":"Offer","price":299.95,"priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>`;
r = extract(d, "https://www.ldlc.com/fiche/1"); assert.equal(r.gtin, "4548736132580"); assert.equal(r.stock, "in"); assert.equal(r.name, "Sony WH-1000XM5"); assert.equal(r.prices, 1);
const e = `<script type="application/ld+json">{"@type":"Product","offers":[{"@type":"Offer","price":10,"availability":"http://schema.org/OutOfStock"},{"@type":"Offer","price":12}]}</script>`;
r = extract(e, "https://x.fr/p"); assert.equal(r.stock, "out"); assert.equal(r.prices, 2);
assert.equal(extract(`<script type="application/ld+json">{"@type":"Product","offers":{"price":5,"availability":"https://schema.org/PreOrder"}}</script>`, "https://x.fr/p").stock, "pre");
assert.equal(extract("<html></html>", "https://x.fr/p").stock, "");
assert.equal(cleanGtin("0 0000 0000 0000"), ""); assert.equal(cleanGtin("abc"), ""); assert.equal(cleanGtin("6941565969903"), "6941565969903");
assert.equal(extract(`<script>var x={"gtin13":"6941565969903"}</script>`, "https://x.fr/p").gtin, "6941565969903");
console.log("parse v6 OK");

// Déclinaisons (Shopify) : le lien ?variant=ID désigne la déclinaison, même si la balise meta annonce le prix le plus bas
const shop = (offers) => `<meta property="og:price:amount" content="189.90"><script type="application/ld+json">{"@type":"Product","name":"Surmatelas Duo","offers":${JSON.stringify(offers)}}</script>`;
r = extract(shop([{ "@type": "Offer", price: "259.90", priceCurrency: "EUR", availability: "http://schema.org/InStock", url: "https://m.fr/products/duo" }]), "https://m.fr/products/duo?variant=231");
assert.equal(r.price, 259.9); assert.equal(r.prices, 1); assert.equal(r.stock, "in");
r = extract(shop([{ "@type": "Offer", price: "189.90", priceCurrency: "EUR", url: "https://m.fr/products/duo?variant=1" }, { "@type": "Offer", price: "259.90", priceCurrency: "EUR", availability: "OutOfStock", url: "https://m.fr/products/duo?variant=231" }]), "https://m.fr/products/duo?variant=231");
assert.equal(r.price, 259.9); assert.equal(r.prices, 1); assert.equal(r.stock, "out");
// sans ?variant= : plusieurs prix, lecture ambiguë, mais la liste des déclinaisons est fournie
r = extract(shop([{ "@type": "Offer", price: "40", priceCurrency: "EUR" }, { "@type": "Offer", price: "55", priceCurrency: "EUR", availability: "InStock" }]), "https://g.fr/products/drap");
assert.equal(r.prices > 1, true); assert.deepEqual(r.variants, [{ price: 40, stock: "" }, { price: 55, stock: "in" }]);
// ?variant= inconnu et plusieurs offres : aucune déclinaison choisie
r = extract(shop([{ "@type": "Offer", price: "40", priceCurrency: "EUR" }, { "@type": "Offer", price: "55", priceCurrency: "EUR" }]), "https://g.fr/products/drap?variant=9");
assert.equal(r.prices > 1, true);
console.log("variants OK");

// Groupe de déclinaisons : la photo est sur la déclinaison du lien (cas Decathlon, 28 novembre)
{
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const page = ld({ "@type": "ProductGroup", name: "Veste" })
    + ld({ "@type": "Product", sku: "1111111", image: "https://img.test/vert.jpg" })
    + ld({ "@type": "Product", sku: "8667206", image: "https://img.test/marron.jpg" });
  const img = (u) => extract(page, u).image;
  if (img("https://www.decathlon.fr/p/veste/335543/c115c387m8667206") !== "https://img.test/marron.jpg") throw new Error("déclinaison du lien");
  if (img("https://www.decathlon.fr/p/veste") !== "https://img.test/vert.jpg") throw new Error("première déclinaison");
  console.log("photo de déclinaison OK");
}
