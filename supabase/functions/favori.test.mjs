// Le « favori magique » (site/favori.txt) est une copie exacte du lecteur de page de l'extension (extension/extract.js).
// Après une modification de l'un, recopier : cp extension/extract.js site/favori.txt
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const a = readFileSync(new URL("extension/extract.js", root), "utf8"), b = readFileSync(new URL("site/favori.txt", root), "utf8");
assert.equal(b, a, "site/favori.txt diffère de extension/extract.js");
// Le favori retire les lignes de commentaire et rejoint le reste : aucun commentaire « // » en fin de ligne de code ne doit exister
for (const [i, l] of a.split("\n").entries()) {
  const t = l.trim();
  if (t.startsWith("//")) continue;
  assert.ok(!/[;,{}()\]]\s*\/\/\s/.test(t), `ligne ${i + 1} : commentaire « // » en fin de ligne`);
}
new Function(a + "\nreturn extractPage;"); // syntaxe valide
console.log("favori.test.mjs : OK");
