// Logique commune de l'extension (sans accès au navigateur : testable avec node).
// Les listes MARKET et COMPARATOR sont copiées de supabase/functions/noel-preview/offers.js :
// à garder identiques (voir extension/README.md, « Maintenance »).

export const MARKET = ["leboncoin","vinted","ebay","backmarket","facebook","marketplace","cashconverters","easycash","rakuten","aliexpress","alibaba","temu","rebuy","momox","recommerce","etsy","shein","olx","ricardo","kleinanzeigen","2ememain","ubuy","onbuy","beebs","wish","joom","banggood","dhgate","brickowl","bricklink","stockx","madeinchina","seller","vendeur"];
export const COMPARATOR = ["achatmoinscher","kulturegeek","idealo","kelkoo","leguide","shopzilla","pricerunner","dealabs","pricespy","twenga","shopmania","googleshopping","comparer"];

const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const alnum = s => norm(s).replace(/[^a-z0-9]/g, "");

// Place de marché, site d'occasion ou comparateur : jamais présenté comme une offre
export function isMarket(store, url = "") {
  const raw = String(store ?? "").trim();
  const s = alnum(raw);
  let h = "";
  try { h = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, ""); } catch (e) { /* adresse invalide */ }
  if (MARKET.concat(COMPARATOR).some(m => (s && s.includes(m)) || (h && h.includes(m)))) return true;
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(raw);   // identifiant de vendeur
}

export const totalOf = o => o.price + (typeof o.shipping === "number" ? o.shipping : 0);

// Adresse de la page sans suivi publicitaire ni ancre
const TRACK = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|mc_|igshid$|ref$|ref_$|tag$|cmpid$|cmp$|xtor$|affil|aff_|awc$|ranMID$|ranEAID$|ranSiteID$|spm$|_ga$)/i;
export function cleanUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return "";
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch (e) { return ""; }
}

// « Boulanger » depuis www.boulanger.com ; « Amazon.fr » pour amazon.fr (comme les noms donnés par Google)
export function storeFromHost(host, siteName = "") {
  const sn = String(siteName || "").trim();
  if (sn && sn.length <= 40 && !/\s{2,}/.test(sn)) return sn;
  const h = String(host || "").toLowerCase().replace(/^(www|m|shop|boutique|store)\./, "");
  const parts = h.split(".");
  if (parts.length < 2) return h;
  const label = parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return label === "amazon" ? "Amazon." + parts[parts.length - 1] : name;
}

// « 1 299,00 » → 1299 ; « 1,299.00 » → 1299 ; texte invalide → null
export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) && v > 0 && v < 100000 ? Math.round(v * 100) / 100 : null;
  let t = String(v).replace(/[^\d.,]/g, "");
  if (!t) return null;
  const lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (lc >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  else if (/\.\d{3}$/.test(t) && (t.match(/\./g) || []).length >= 1 && !/^0\./.test(t)) t = t.replace(/\./g, "");
  const n = parseFloat(t);
  return isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

export const eur = n => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);

// Offre telle qu'elle est enregistrée (même forme que offerOut dans site/index.html)
export const offerOut = o => ({
  store: String(o.store).slice(0, 60), price: o.price, url: o.url,
  shipping: typeof o.shipping === "number" ? o.shipping : null,
  verified: !!o.verified, at: o.at || null, stock: o.stock || "", via: o.via || "",
  trust: o.trust && ["known", "unknown", "caution"].includes(o.trust.l)
    ? { l: o.trust.l, r: (Array.isArray(o.trust.r) ? o.trust.r : []).filter(x => typeof x === "string").slice(0, 3).map(x => x.slice(0, 120)) }
    : null,
});

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

// Offres à enregistrer.
//  - search : réponse de noel-preview (ou null si la recherche n'a pas été faite)
//  - page   : { url, store, price, stockOut } lus sur la page ouverte
// L'offre de la page est ajoutée telle que lue (non vérifiée par le serveur, date du jour),
// sauf si c'est une place de marché, un comparateur, une adresse non https ou un prix inconnu.
export function buildOffers(search, page, now = new Date().toISOString()) {
  let offers = [];
  if (search && Array.isArray(search.offers)) {
    offers = search.offers.filter(o => o && /^https:\/\//.test(o.url || "") && +o.price > 0 && !isMarket(o.store, o.url)).map(offerOut);
  }
  if (page && page.price > 0 && /^https:\/\//.test(page.url || "") && !isMarket(page.store, page.url)) {
    const h = hostOf(page.url);
    if (!offers.some(o => hostOf(o.url) === h)) {
      offers.push(offerOut({ store: page.store, price: page.price, url: page.url, shipping: null, verified: false, at: now, stock: page.stockOut ? "out" : "", via: "", trust: null }));
    }
  }
  const inStock = offers.filter(o => o.stock !== "out").sort((a, b) => totalOf(a) - totalOf(b));
  const best = inStock[0] || null;
  return { offers, best };
}

// Cadeau déjà dans la liste ? (même adresse, ou au moins 2 mots communs et mêmes chiffres)
const tk = s => norm(s).split(/[^a-z0-9]+/).filter(t => t.length > 1);
export function dupOf(gifts, title, url) {
  const u = cleanUrl(url);
  const a = new Set(tk(title));
  for (const g of gifts || []) {
    if (u && g.url && cleanUrl(g.url) === u) return g;
    const b = new Set(tk(g.title));
    if (a.size < 2 || b.size < 2) continue;
    const da = [...a].filter(t => /\d/.test(t)), db = [...b].filter(t => /\d/.test(t));
    if (da.some(t => !b.has(t)) || db.some(t => !a.has(t))) continue;
    let hit = 0; a.forEach(t => { if (b.has(t)) hit++; });
    if (hit >= 2 && hit / Math.min(a.size, b.size) >= 0.8) return g;
  }
  return null;
}

export function normalizeSite(input) {
  let t = String(input || "").trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) return "";
  if (!/^https?:\/\//i.test(t)) t = "https://" + t;
  try { const x = new URL(t); return /^https?:$/.test(x.protocol) ? x.origin : ""; } catch (e) { return ""; }
}

// « Mon code » collé sous forme de lien https://site/#c=CODE : on garde le code
export function extractCode(t) {
  const s = String(t || "").trim();
  const m = s.match(/[#&]c=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : s;
}

export const MSG = {
  denied: "Le code propriétaire est refusé.",
  throttled: "Trop d'essais. Réessaie dans quelques minutes.",
  invalid: "Une valeur n'est pas valide (nom, prix ou adresse).",
};
