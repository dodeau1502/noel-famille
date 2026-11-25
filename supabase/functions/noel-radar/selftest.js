// Test quotidien (lot L) : parties pures. Les lectures réseau sont dans selftest.ts.
import { parseFeed, factOf } from "./dealabs.js";
import { conditionsOf } from "./conditions.js";
import { matchAll } from "./match.js";

// Cadeaux fictifs : jamais ceux de la base
const G = (id, o) => ({ id, title: "", variant: null, gtin: null, asin: null, mpn: null, aliases: [], url: null, offers: [], price: null, ...o });
const GIFTS = [
  G(1, { title: "Montre Garmin vivoactive 5" }),
  G(2, { title: "Jeu DJ SET", gtin: "3770022054332" }),
  G(3, { title: "Cadeau sans rapport", asin: "B08Q3GLFXP" }),
  G(4, { title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "X", price: 249 }] }),
];
const EXPECTED = { items: 30, matches: { "1": "strict", "2": "exact", "3": "exact", "4": "strict" } };

// 1. Régression du code : le fichier de test donne toujours le même résumé. Renvoie la liste des écarts (vide = bon).
export function checkCode(xml) {
  const bad = [];
  const { items } = parseFeed(xml);
  if (items.length !== EXPECTED.items) bad.push(`flux de test : ${items.length} éléments au lieu de ${EXPECTED.items}`);
  const facts = items.map(factOf);
  if (items[0] && (items[0].merchant !== "Bax Music" || items[0].price !== 91)) bad.push("premier élément du flux de test modifié");
  const got = {};
  for (const m of matchAll(GIFTS, facts)) if (m.level !== "loose") got[m.gift_id] = m.level;
  for (const [id, lvl] of Object.entries(EXPECTED.matches)) if (got[id] !== lvl) bad.push(`rapprochement du cadeau ${id} : ${got[id] ?? "aucun"} au lieu de ${lvl}`);
  const eco = facts.find((f) => f.title.includes("Ecovacs"));
  const types = eco ? conditionsOf(eco.title, eco.html).map((c) => c.type) : [];
  if (!types.includes("code")) bad.push("conditions : le code promo Ecovacs n'est plus reconnu");
  return bad;
}

// 2. Format réel : la dernière lecture a-t-elle encore la forme attendue ? stats = { items, withTitleLink, withMerchant } ou null (pas encore lu).
export function checkFormat(stats) {
  if (!stats) return null;                                    // pas de lecture complète depuis le démarrage : non évalué, pas un échec
  if (stats.withTitleLink < 5) return `format Dealabs : ${stats.withTitleLink} éléments avec titre et lien (5 attendus au moins)`;
  if (stats.withMerchant < 1) return "format Dealabs : plus aucun marchand (pepper:merchant) dans le flux";
  return null;
}

export const statsOf = (items) => ({ items: items.length, withTitleLink: items.filter((i) => i.title && i.link).length, withMerchant: items.filter((i) => i.merchant).length });
