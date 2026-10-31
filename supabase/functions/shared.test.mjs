// Les modules communs de noel-preview et noel-refresh doivent rester identiques (chaque fonction est déployée avec ses propres fichiers)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const dir = new URL(".", import.meta.url).pathname;
for (const f of ["parse.js", "offers.js", "verify.js", "net.ts"]) {
  assert.equal(readFileSync(`${dir}noel-preview/${f}`, "utf8"), readFileSync(`${dir}noel-refresh/${f}`, "utf8"), `${f} différent entre noel-preview et noel-refresh`);
}
console.log("shared OK");
