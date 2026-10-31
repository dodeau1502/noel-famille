// Vérification d'une offre en la comparant à la page du marchand (sans réseau : testable hors ligne)
import { matchesLoose, totalOf } from "./offers.js";

const TOLERANCE = 0.03; // écart de prix accepté entre Google et la page du marchand

// offer : {store, price, url, shipping, ...} ; info : résultat de extract() sur la page du marchand, ou null si illisible.
// Résultat : la même offre avec verified (prix confirmé par la page du marchand), stock ("in", "out", "pre" ou ""), at (date ISO de la dernière confirmation).
export function applyPage(offer, info, query, now = new Date()) {
  const o = { ...offer };
  if (!info || !(info.price > 0)) return { ...o, verified: false };            // page illisible ou bloquée : on garde le dernier prix connu
  const diff = Math.abs(info.price - o.price) / o.price;
  const same = diff <= TOLERANCE;
  if (!same) {
    // La page annonce un autre prix : on l'accepte seulement si la page décrit bien le produit et si la lecture n'est pas ambiguë
    const ratio = info.price / o.price;
    const named = matchesLoose(query, info.name || info.title || "");
    if (info.prices > 1 || !named || ratio < 0.5 || ratio > 1.6) return { ...o, verified: false };
  }
  return { ...o, price: info.price, verified: true, stock: info.stock || "", at: now.toISOString() };
}

// Meilleure offre : la moins chère (livraison comprise) parmi celles qui ne sont pas en rupture
export function bestOffer(offers) {
  const ok = (offers || []).filter(o => o && o.stock !== "out" && o.price > 0);
  return ok.sort((a, b) => totalOf(a) - totalOf(b))[0] || null;
}

// Classement : en rupture à la fin, sinon prix + livraison
export function rank(offers) {
  const key = o => (o.stock === "out" ? 1e9 : 0) + totalOf(o);
  return [...(offers || [])].sort((a, b) => key(a) - key(b));
}
