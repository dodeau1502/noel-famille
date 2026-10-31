// Sécurité des marchands : niveau de confiance affiché avec chaque offre (sans réseau : testable hors ligne).
// Niveaux : « known » (marchand de la liste ci-dessous), « unknown » (aucun signal), « caution » (au moins un signal négatif, avec sa raison),
// « out » (cas grave : l'offre n'est pas proposée). Ce n'est jamais une garantie : un escroc peut avoir un vieux domaine ou de faux avis.
import { norm } from "./offers.js";

export const keyOf = s => norm(s).replace(/[^a-z0-9]/g, "");
export const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (_) { return ""; } };
export const isGoogleHost = h => /(^|\.)google\.[a-z.]+$/i.test(h);

// Domaine « enregistrable » : last 2 labels (3 pour co.uk, com.fr…)
export function registrable(host) {
  const p = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (p.length < 2) return "";
  const sld = new Set(["co", "com", "org", "net", "gov", "ac"]);
  const n = p.length >= 3 && p[p.length - 1].length === 2 && sld.has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}

// [clés de nom, domaines] : marchands connus, tenus à la main (sites reconnus, marques officielles). À compléter avec prudence.
const KNOWN = [
  [["amazon", "amazonfr"], ["amazon.fr", "amazon.com"]],
  [["fnac", "fnaccom"], ["fnac.com"]],
  [["darty", "dartycom"], ["darty.com"]],
  [["boulanger", "boulangercom"], ["boulanger.com"]],
  [["cdiscount", "cdiscountcom"], ["cdiscount.com"]],
  [["ldlc", "ldlccom"], ["ldlc.com"]],
  [["materielnet"], ["materiel.net"]],
  [["topachat", "topachatcom"], ["topachat.com"]],
  [["grosbill", "grosbillcom"], ["grosbill.com"]],
  [["rueducommerce"], ["rueducommerce.fr"]],
  [["carrefour", "carrefourfr"], ["carrefour.fr"]],
  [["eleclerc", "leclerc", "eleclercfr"], ["e.leclerc"]],
  [["auchan", "auchanfr"], ["auchan.fr"]],
  [["intermarche"], ["intermarche.com"]],
  [["monoprix"], ["monoprix.fr"]],
  [["lidl"], ["lidl.fr"]],
  [["leroymerlin"], ["leroymerlin.fr"]],
  [["castorama"], ["castorama.fr"]],
  [["bricodepot"], ["bricodepot.fr"]],
  [["decathlon", "decathlonfr"], ["decathlon.fr"]],
  [["intersport"], ["intersport.fr"]],
  [["ikea", "ikeafr"], ["ikea.com"]],
  [["conforama"], ["conforama.fr"]],
  [["but"], ["but.fr"]],
  [["electrodepot"], ["electrodepot.fr"]],
  [["micromania", "micromaniazing"], ["micromania.fr"]],
  [["cultura"], ["cultura.com"]],
  [["lagranderecre"], ["lagranderecre.fr"]],
  [["orange"], ["orange.fr"]],
  [["bouyguestelecom"], ["bouyguestelecom.fr"]],
  [["sfr"], ["sfr.fr"]],
  // Boutiques officielles de marques
  [["dji", "djistore", "djiofficialstore"], ["dji.com"]],
  [["apple", "applestore"], ["apple.com"]],
  [["samsung", "samsungstore"], ["samsung.com"]],
  [["sony", "sonystore", "sonycentre"], ["sony.fr", "sony.com"]],
  [["nintendo", "nintendostore"], ["nintendo.com", "nintendo.fr"]],
  [["playstation", "playstationdirect"], ["playstation.com"]],
  [["microsoft", "microsoftstore"], ["microsoft.com"]],
  [["lego", "legoshop"], ["lego.com"]],
  [["dyson"], ["dyson.fr"]],
  [["bose"], ["bose.fr", "bose.com"]],
  [["philips"], ["philips.fr"]],
  [["logitech"], ["logitech.com"]],
  [["lenovo"], ["lenovo.com"]],
  [["asus", "asusstore"], ["asus.com"]],
  [["garmin"], ["garmin.com"]],
];

const onHost = (host, d) => host === d || host.endsWith("." + d);

// Marchand connu : par son domaine quand la page du marchand est connue ; par son nom seulement quand l'adresse est un lien Google
// (le nom vient alors de Google, qui vérifie les marchands). Limite : « Amazon.fr » désigne le site, pas chaque vendeur tiers.
export function isKnown(store, url) {
  const host = hostOf(url), nk = keyOf(store);
  for (const [names, hosts] of KNOWN) {
    if (host && !isGoogleHost(host)) { if (hosts.some(d => onHost(host, d))) return true; }
    else if (names.includes(nk)) return true;
  }
  return false;
}

const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const fmt = n => String(Math.round(n * 10) / 10).replace(".", ",");

// ctx : { rating, reviews } (note Google du marchand), ageDays (âge du domaine, null si inconnu),
// belowMedian (part du prix en dessous de la médiane des autres offres, 0 à 1, null si moins de 3 offres)
export function assess(offer, ctx = {}) {
  if (isKnown(offer.store, offer.url)) return { l: "known", r: [] };
  const reasons = [];
  let out = false;
  const rating = num(ctx.rating), reviews = num(ctx.reviews), age = num(ctx.ageDays), below = num(ctx.belowMedian);
  if (rating > 0 && reviews >= 50 && rating < 3) { out = true; reasons.push(`note Google ${fmt(rating)}/5 sur ${reviews} avis`); }
  else if (rating > 0 && reviews >= 20 && rating < 3.5) reasons.push(`note Google ${fmt(rating)}/5 sur ${reviews} avis`);
  if (age !== null && age >= 0) {
    if (age < 90) { out = true; reasons.push("site créé il y a moins de 3 mois"); }
    else if (age < 180) reasons.push(`site créé il y a ${Math.max(3, Math.round(age / 30))} mois`);
  }
  if (below !== null && below >= 0.25) reasons.push(`prix ${Math.round(below * 100)} % sous celui des autres marchands`);
  return out ? { l: "out", r: reasons } : reasons.length ? { l: "caution", r: reasons } : { l: "unknown", r: [] };
}

// Part du prix sous la médiane des AUTRES offres (au moins 2 autres), ou null
export function belowMedian(price, others) {
  const s = (others || []).filter(p => p > 0).sort((a, b) => a - b);
  if (s.length < 2) return null;
  const m = Math.floor(s.length / 2), med = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.max(0, 1 - price / med);
}

// Âge en jours d'après la réponse RDAP d'un domaine (événement « registration »), ou null
export function ageFromRdap(rdap, now = new Date()) {
  const ev = (rdap && Array.isArray(rdap.events) ? rdap.events : []).find(e => e && e.eventAction === "registration" && e.eventDate);
  const t = ev ? new Date(ev.eventDate).getTime() : NaN;
  return Number.isFinite(t) && t <= now.getTime() ? Math.floor((now.getTime() - t) / 86400000) : null;
}

// Liste noire du propriétaire : par nom normalisé ou par domaine
export function isBlocked(offer, blocked) {
  if (!blocked) return false;
  const host = hostOf(offer.url);
  if (blocked.keys && blocked.keys.has(keyOf(offer.store))) return true;
  return !!(host && !isGoogleHost(host) && blocked.hosts && [...blocked.hosts].some(d => onHost(host, d)));
}
