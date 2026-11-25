// Rapprochement d'un deal (Dealabs, Keepa, e-mail) avec les cadeaux de la liste (module pur).
// Confidentialité : ne reçoit que des données de cadeau publiques (jamais de réservation).
import { norm, tokens, keyTokens, matches, matchesLoose, isMarketplace, isComparator, isUsed, isAccessory, totalOf } from "../noel-preview/offers.js";
import { pad14 } from "./dealabs.js";

// gift = { id, title, variant, gtin, asin, mpn, aliases[], url, offers[], price }
// fact = { guid, title, merchant, price, links[], asins[], gtins[], mpns[] }

// --- Version : contrôlée sur la partie « modèle » du titre -------------------------------------------------
// Les titres Dealabs ajoutent des caractéristiques après « - » ou « , » (« … Gen 2 - 21 000 Pa, Ultra-fin 8,1 cm ») : le mot « ultra »
// y fait croire à une autre version. `matches` n'est pas modifié (utilisé ailleurs) : on contrôle ici la version sur la partie modèle.
const VARIANTS = new Set(["pro", "max", "plus", "ultra", "lite", "mini", "xl", "slim", "combo", "bundle", "pack", "kit", "adventure", "standard", "creator", "essential", "edition"]);
const variantSet = s => [...new Set(tokens(s).filter(t => VARIANTS.has(t)))].sort().join(",");

// Texte avant le premier « - », « – », « | » ou « , » qui suit au moins 2 mots. Retire un préfixe [Prime] et une parenthèse finale (Vendeur Tiers).
export function modelPart(title) {
  let s = String(title ?? "").replace(/^\s*(\[[^\]]*\]\s*)+/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const re = /\s[-–|]\s|,\s/g;
  let m;
  while ((m = re.exec(s))) {
    if (s.slice(0, m.index).trim().split(/\s+/).length >= 2) return s.slice(0, m.index).trim();
  }
  return s;
}

const sameVersion = (title, query) => variantSet(modelPart(title)) === variantSet(query);

// Requêtes du cadeau : titre, version souhaitée, surnoms
const queriesOf = gift => [gift.title, gift.variant, ...(Array.isArray(gift.aliases) ? gift.aliases : [])].map(q => String(q ?? "").trim()).filter(q => q.length >= 2);

// Marque et référence : « Ecovacs » doit figurer dans le titre du cadeau ET du deal pour qu'un titre générique ne suffise pas
function strict(q, title) {
  const qt = keyTokens(q);
  return qt.length > 0 && matches(qt, title, title) && sameVersion(title, q);   // matches(qt, titre, titre) : version neutralisée, contrôlée par sameVersion
}
function loose(q, title) {
  return matchesLoose(q, title, { variants: false }) && sameVersion(title, q);
}

// --- Identifiants -----------------------------------------------------------------------------------------
const asinOf = url => { try { const m = new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/); return m ? m[1] : null; } catch (_) { return null; } };
const linkKey = url => { try { const u = new URL(url); return u.hostname.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/+$/, ""); } catch (_) { return ""; } };

// Clé d'une référence constructeur : majuscules, lettres et chiffres seulement. Inutilisable si elle ressemble à un code-barres,
// fait moins de 5 caractères ou ne contient aucun chiffre.
export function mpnKey(s) {
  const raw = String(s ?? "").trim();
  const k = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // « chiffres seuls » : la saisie elle-même n'est que des chiffres (« 9000-0007-4142 » a des séparateurs, c'est une référence)
  if (k.length < 5 || !/\d/.test(k) || /^\d{8}$|^\d{12,14}$/.test(raw)) return "";
  return k;
}
const compact = s => norm(s).replace(/[^a-z0-9]/g, "").toUpperCase();

function exactBy(gift, fact) {
  const asins = new Set([gift.asin, asinOf(gift.url), ...(gift.offers || []).map(o => asinOf(o?.url))].filter(Boolean));
  const gtin = gift.gtin ? pad14(gift.gtin) : "";
  if (gtin && (fact.gtins || []).some(g => pad14(g) === gtin)) return "code-barres";
  if ((fact.asins || []).some(a => asins.has(a))) return "ASIN";
  const key = mpnKey(gift.mpn);
  if (key) {
    const hit = (fact.mpns || []).some(m => mpnKey(m) === key) || compact(fact.title).includes(key);
    // La marque (premier mot-clé du titre du cadeau) doit figurer dans le titre du deal : évite les collisions entre marques
    const brand = tokens(gift.title)[0];
    if (hit && brand && tokens(fact.title).includes(brand)) return "référence constructeur";
  }
  const mine = new Set([gift.url, ...(gift.offers || []).map(o => o?.url)].filter(Boolean).map(linkKey).filter(Boolean));
  if ((fact.links || []).some(l => mine.has(linkKey(l)))) return "lien identique";
  return null;
}

// → { level: 'exact'|'strict'|'loose'|null, reason }
export function matchGift(gift, fact) {
  const e = exactBy(gift, fact);
  if (e) return { level: "exact", reason: e };
  const qs = queriesOf(gift);
  const s = qs.find(q => strict(q, fact.title));
  if (s) return { level: "strict", reason: `titre : « ${s} »` };
  const l = qs.find(q => loose(q, fact.title));
  if (l) return { level: "loose", reason: `titre approchant : « ${l} »` };
  return { level: null, reason: "" };
}

// Meilleur prix actuel (livraison comprise si connue), hors rupture ; à défaut le prix de la fiche ; null s'il n'y en a pas
export function bestTotal(gift) {
  const offers = (gift.offers || []).filter(o => o && o.stock !== "out" && o.price > 0);
  if (offers.length) return Math.min(...offers.map(totalOf));
  return gift.price > 0 ? gift.price : null;
}

// → null, ou la raison d'écarter le deal (« prix suspect » n'est pas une exclusion : voir suspect())
export function excluded(fact, gift) {
  const link = (fact.links || [])[0] || "";
  const store = fact.merchant || "";
  if (isComparator(store, link)) return "comparateur";
  if (isMarketplace(store, link)) return "place de marché";
  if (/vendeurs? tiers?/.test(norm(fact.title))) return "vendeur tiers";
  if (isUsed({ title: fact.title }, gift.title)) return "occasion";
  if (isAccessory(modelPart(fact.title), gift.title)) return "accessoire";
  const best = bestTotal(gift);
  if (fact.price > 0 && best != null && fact.price >= best) return "pas moins cher";
  return null;
}

// Prix très bas (moins de 0,4 fois le meilleur prix) : la piste est gardée mais porte une condition « Prudence »
export function suspect(fact, gift) {
  const best = bestTotal(gift);
  return fact.price > 0 && best != null && fact.price < best * 0.4;
}

export const titleKey = t => norm(t).replace(/[^a-z0-9]/g, "");

// → [{ gift_id, fact, level, reason, extra }] pour toutes les paires retenues.
// opts.rejected : Set de « idCadeau|titreNormalisé » refusés par le propriétaire (ils ne reviennent pas) ; opts.onSkip(gift, fact, raison) : journal.
export function matchAll(gifts, facts, opts = {}) {
  const out = [];
  for (const fact of facts) {
    for (const gift of gifts) {
      const m = matchGift(gift, fact);
      if (!m.level) continue;
      if (opts.rejected && opts.rejected.has(`${gift.id}|${titleKey(fact.title)}`)) { opts.onSkip?.(gift, fact, "refusé par le propriétaire"); continue; }
      const why = excluded(fact, gift);
      if (why) { opts.onSkip?.(gift, fact, why); continue; }
      const extra = suspect(fact, gift) ? [{ type: "prudence", label: "Prix très bas : vérifier la version" }] : [];
      out.push({ gift_id: gift.id, fact, level: m.level, reason: m.reason, extra });
    }
  }
  return out;
}
