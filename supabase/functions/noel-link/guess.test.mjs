import assert from "node:assert/strict";
import { nameFromUrl } from "./guess.js";
const cases = [
  ["https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319-2?categoryId=61973054", "Lace trim layering cami"],
  ["https://www.amazon.fr/Sony-WH-1000XM5-Casque-Bluetooth/dp/B09XS7JWHH/ref=sr_1_1", "Sony wh 1000xm5 casque bluetooth"],
  ["https://www.zara.com/fr/fr/veste-oversize-en-laine-p02753011.html?v1=1", "Veste oversize en laine"],
  ["https://www.decathlon.fr/p/sac-a-dos-de-randonnee-20l-nh100/_/R-p-301254", "Sac a dos de randonnee 20l nh100"],
  ["https://www.lego.com/fr-fr/product/millennium-falcon-75192", "Millennium falcon"],
  ["https://www.fnac.com/a17253841/Sony-PlayStation-5-Slim", "Sony playstation 5 slim"],
  ["https://exemple.fr/", ""],
  ["https://exemple.fr/p/123456789", ""],
  ["pas une adresse", ""],
];
for (const [u, want] of cases) assert.equal(nameFromUrl(u), want, u);
console.log("guess.test.mjs : " + cases.length + " cas OK");
