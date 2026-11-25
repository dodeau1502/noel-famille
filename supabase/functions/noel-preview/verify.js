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
  if (!same && Array.isArray(info.variants)) {
    // Page à plusieurs déclinaisons (tailles, couleurs) : le prix connu est confirmé s'il correspond à l'une d'elles
    const v = info.variants.find(x => x && x.price > 0 && Math.abs(x.price - o.price) / o.price <= TOLERANCE);
    if (v) return { ...o, price: v.price, verified: true, stock: v.stock || info.stock || "", at: now.toISOString() };
  }
  if (!same) {
    // La page annonce un autre prix : on l'accepte seulement si la page décrit bien le produit et si la lecture n'est pas ambiguë
    const ratio = info.price / o.price;
    const named = matchesLoose(query, info.name || info.title || "");
    if (info.prices > 1 || !named || ratio < 0.5 || ratio > 1.6) return { ...o, verified: false };
  }
  return { ...o, price: info.price, verified: true, stock: info.stock || "", at: now.toISOString() };
}

// Fraîcheur d'un prix (lot Q) : un prix non reconfirmé ne reste pas présenté comme actuel.
// vérifiée : 24 h « fresh », 72 h « aging » ; non vérifiée : 48 h « unverified » ; au-delà : « stale ».
// Date de l'offre : o.at, à défaut fallbackAt (offers_at de la fiche). Sans date du tout, on ne peut pas juger : jamais « stale ».
const H = 3600e3;
export function freshness(o, now = new Date(), fallbackAt = null) {
  const t = new Date((o && o.at) || fallbackAt || NaN).getTime();
  if (!o || isNaN(t)) return o && o.verified ? "aging" : "unverified";
  const age = now.getTime() - t;
  if (o.verified) return age <= 24 * H ? "fresh" : age <= 72 * H ? "aging" : "stale";
  return age <= 48 * H ? "unverified" : "stale";
}

// Meilleure offre : la moins chère (livraison comprise) parmi celles qui ne sont pas en rupture ni périmées (« Ancien prix »)
export function bestOffer(offers, now = new Date(), fallbackAt = null) {
  const ok = (offers || []).filter(o => o && o.stock !== "out" && o.price > 0 && freshness(o, now, fallbackAt) !== "stale");
  return ok.sort((a, b) => totalOf(a) - totalOf(b))[0] || null;
}

// Classement : en rupture à la fin, sinon prix + livraison
export function rank(offers, now = new Date(), fallbackAt = null) {
  const key = o => (o.stock === "out" ? 2e9 : 0) + (freshness(o, now, fallbackAt) === "stale" ? 1e9 : 0) + totalOf(o);
  return [...(offers || [])].sort((a, b) => key(a) - key(b));
}
