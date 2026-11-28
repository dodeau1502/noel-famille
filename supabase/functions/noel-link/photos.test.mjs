// node supabase/functions/noel-link/photos.test.mjs
import assert from "node:assert/strict";
import { brandOf, candidates, imageQuery, searchUrl } from "./photos.js";

const L = "https://www.hollisterco.com/shop/eu-fr/p/cami-1";
assert.equal(brandOf(L), "hollisterco");
assert.equal(brandOf("https://shop.lego.co.uk/x"), "lego");
assert.equal(imageQuery("Caraco dentelle", "Noir", L), "Caraco dentelle Noir hollisterco");
assert.equal(imageQuery("Casque Sony noir", "Noir", "https://www.sony.fr/p"), "Casque Sony noir");
assert.equal(imageQuery("", "", "https://www.amazon.fr/dp/B09XS7JWHH?x=1"), "B09XS7JWHH amazon");
assert.equal(imageQuery("", "", "https://www.fnac.com/"), "");
assert.ok(searchUrl("a b", "k").includes("engine=google_images&q=a+b"));
const data = { images_results: [
  { original: "https://autre.fr/1.jpg", link: "https://autre.fr/p" },
  { original: "http://pas-sur.fr/2.jpg", link: "https://pas-sur.fr" },
  { original: "https://i.pinimg.com/3.jpg", link: "https://pinterest.com/p" },
  { original: "https://img.cdn.net/4.jpg", link: "https://www.hollisterco.com/p" },
] };
assert.deepEqual(candidates(data, L), ["https://img.cdn.net/4.jpg", "https://autre.fr/1.jpg"]);
assert.deepEqual(candidates({ error: "x" }, L), []);
console.log("photos OK");
