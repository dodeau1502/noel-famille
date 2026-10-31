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
