// Parité : le tableau de fraîcheur de site/index.html doit donner les mêmes états que verify.js (lot Q)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { freshness } from "./noel-preview/verify.js";
const dir = new URL(".", import.meta.url).pathname;
const html = readFileSync(`${dir}../../site/index.html`, "utf8");
const m = html.match(/const freshness = [\s\S]*?\n};\n/);
assert.ok(m, "freshness introuvable dans index.html");
const page = new Function(`${m[0]}; return freshness;`)();
const NOW = new Date("2026-11-01T10:00:00Z");
for (const verified of [true, false]) for (const h of [0, 1, 23, 24, 24.02, 47, 48, 48.02, 71, 72, 72.02, 200]) for (const withAt of [true, false]) {
  const o = { verified, at: withAt ? new Date(NOW - h * 3600e3).toISOString() : undefined };
  assert.equal(page(o, null, NOW.getTime()), freshness(o, NOW), JSON.stringify([verified, h, withAt]));
}
console.log("freshness parity OK");
