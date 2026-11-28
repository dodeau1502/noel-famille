// Nom deviné d'après l'adresse, quand la page ne se laisse pas lire (mur anti-robots : Hollister, Amazon, Fnac…).
// Ex. /shop/eu-fr/p/lace-trim-layering-cami-63270319-2 → « Lace trim layering cami ». Pur, testé par guess.test.mjs.
const ID = /^(?:\d{5,}|[a-z]?\d{6,}|b0[a-z0-9]{8}|[a-z0-9]{12,})$/i; // numéros de produit, ASIN, empreintes
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2})?$/i; // « fr », « eu-fr », « fr_FR »

export function nameFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { return ""; }
  let best = [];
  for (const seg of url.pathname.split("/")) {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch (_) {}
    s = s.replace(/\.(html?|aspx|php)$/i, "");
    if (LOCALE.test(s)) continue;
    const words = s.split(/[-_+\s.]+/).filter(Boolean).filter((w) => !ID.test(w));
    while (words.length && /^\d{1,2}$/.test(words[words.length - 1])) words.pop(); // « -2 » final (déclinaison)
    const letters = words.filter((w) => /\p{L}{2,}/u.test(w)).length;
    // Le segment le plus « parlant » (le plus de mots), à égalité le dernier
    if (letters >= 2 && letters >= best.filter((w) => /\p{L}{2,}/u.test(w)).length) best = words;
  }
  if (!best.length) return "";
  const t = best.join(" ").slice(0, 120).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
