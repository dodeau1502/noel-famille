// node supabase/functions/noel-link/page.test.mjs
import assert from "node:assert/strict";
import { pageMaterial, parsePage } from "./page.js";

const html = `<html><head><meta property="og:image" content="/a.jpg"></head><body><nav>Menu 5,00 €</nav><h1>Pull</h1>
<p>Prix 1 299,00 € puis 49,9 € et 30 €</p><select><option>S</option><option selected>M</option></select>
<button aria-pressed="true" aria-label="Bleu marine"></button><img src="/b.jpg" alt="Pull bleu"><img src="/logo.png" alt="logo"><script>var x = 7.77</script></body></html>`;
const m = pageMaterial(html, "https://shop.test/p/pull");
assert.deepEqual(m.images.map((i) => i.url), ["https://shop.test/a.jpg", "https://shop.test/b.jpg"]);
assert.equal(m.chosen, "M | Bleu marine");
assert.ok(!m.text.includes("7.77"));

const res = (o) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
const base = { is_product: true, title: "Pull", color: "", size: "M", details: "", image: 1 };
const price = (p) => parsePage(res({ ...base, price: p }), m).price;
assert.equal(price(1299), 1299);
assert.equal(price(49.9), 49.9);
assert.equal(price(30), 30);
for (const p of [299, 9, 7.77, 49, 12.5]) assert.equal(price(p), null, String(p));
assert.equal(parsePage(res({ ...base, price: null }), m).image, "https://shop.test/b.jpg");
assert.equal(parsePage(res({ ...base, price: 30, image: 9 }), m).image, "");
assert.equal(parsePage(res({ ...base, is_product: false }), m), null);
assert.equal(parsePage({}, m), null);
console.log("page OK");
