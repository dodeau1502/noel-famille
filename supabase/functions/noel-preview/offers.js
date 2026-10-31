// Choix des offres fiables à partir des résultats Google Shopping (SerpAPI)
const STOP = new Set(["de","la","le","les","du","des","un","une","et","pour","avec","sans","en","au","aux","the","a","of","and","for","with"]);

export function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
export function tokens(s) {
  return norm(s).split(/[^a-z0-9]+/).filter(t => (t.length >= 2 || /\d/.test(t)) && !STOP.has(t)); // un chiffre seul compte : « Action 6 » n'est pas « Action 5 »
}

// Nettoie un titre de page : retire " | Boutique" et, si on connaît la boutique, " - Boutique"
export function cleanTitle(t, store = "") {
  let s = String(t ?? "").replace(/\s+/g, " ").trim();
  s = s.split(/\s[|•–—]\s/)[0];
  const parts = s.split(/\s-\s/);
  const st = norm(store).replace(/[^a-z0-9]/g, "");
  if (parts.length > 1 && st) {
    const last = norm(parts[parts.length - 1]).replace(/[^a-z0-9]/g, "");
    if (last && (st.includes(last) || last.includes(st))) parts.pop();
  }
  return parts.join(" - ").slice(0, 120).trim();
}

// Couleurs : elles ne changent pas le modèle, on ne les exige pas dans les résultats
const COLORS = new Set(["noir","noire","blanc","blanche","bleu","bleue","rouge","gris","grise","vert","verte","rose","argent","silver","black","white","blue","red","grey","gray","green","pink","gold","beige","violet","orange","jaune","titane"]);

// Mots-clés qui identifient le produit : les premiers mots significatifs + TOUTES les références chiffrées de la requête
export function keyTokens(query, n = 6) {
  const all = tokens(query).filter(t => !COLORS.has(t));
  const first = all.slice(0, n);
  const digits = all.filter(t => /\d/.test(t) && !first.includes(t));
  return [...first, ...digits].slice(0, 9);
}

// Mots qui font un produit différent (version, lot) : l'ensemble doit être identique dans la requête et dans le résultat
const VARIANTS = new Set(["pro","max","plus","ultra","lite","mini","xl","slim","combo","bundle","pack","kit","adventure","standard","creator","essential","edition"]);
const variantSet = s => [...new Set(tokens(s).filter(t => VARIANTS.has(t)))].sort().join(",");

// Un résultat correspond seulement si TOUS les mots-clés sont présents et que la version est la même
export function matches(queryTokens, title, query = "") {
  if (!queryTokens.length) return false;
  const set = new Set(tokens(title));
  if (!queryTokens.every(q => set.has(q))) return false;
  return variantSet(title) === variantSet(query);
}

// Conservé pour compatibilité : part des mots-clés trouvés (0 si une référence chiffrée manque)
export function score(queryTokens, title) {
  if (!queryTokens.length) return 0;
  const set = new Set(tokens(title));
  if (queryTokens.some(q => /\d/.test(q) && !set.has(q))) return 0;
  let hit = 0;
  for (const q of queryTokens) if (set.has(q)) hit++;
  return hit / queryTokens.length;
}

// Places de marché et sites d'occasion : prix et vendeurs non vérifiables, on les écarte
const MARKET = ["leboncoin","vinted","ebay","backmarket","facebook","marketplace","cashconverters","easycash","rakuten","aliexpress","alibaba","temu","rebuy","momox","recommerce","etsy","shein","olx","ricardo","kleinanzeigen","2ememain"];
export function isMarketplace(store, url = "") {
  const raw = String(store ?? "").trim();
  const s = norm(raw).replace(/[^a-z0-9]/g, "");
  let h = "";
  try { h = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, ""); } catch (e) { /* url invalide */ }
  if (MARKET.some(m => s.includes(m) || (h && h.includes(m)))) return true;
  // Identifiant de vendeur (« foto-erhardtfr ») : tout en minuscules avec tiret, sans point ni espace
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(raw);
}

const USED = /\b(occasion|reconditionne|reconditionnee|reconditionnes|refurbished|refurb|used|seconde main|remis a neuf|open box|comme neuf|pre owned|preowned)\b/;
export function isUsed(r, query = "") {
  const used = Boolean(r.second_hand_condition) || USED.test(norm(r.title));
  return used && !USED.test(norm(query));
}

// Frais de livraison : nombre en euros, 0 si offerts sans condition, null si inconnus ou conditionnels
export function shippingCost(r) {
  const d = norm([r.delivery, r.shipping].filter(Boolean).join(" "));
  if (!d) return null;
  if (/gratuit|offert|free/.test(d)) return /(des|a partir de|pour|from|over)\s*\d/.test(d) ? null : 0;
  const m = d.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)/);
  return m ? Math.round(parseFloat(m[1].replace(",", ".")) * 100) / 100 : null;
}
export const totalOf = o => o.price + (typeof o.shipping === "number" ? o.shipping : 0);

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function merchantUrl(r) {
  for (const u of [r.link, r.product_link]) {
    try {
      const x = new URL(u);
      if (x.protocol === "https:" && !/(^|\.)google\.[a-z.]+$/i.test(x.hostname)) return x.toString();
    } catch (e) { /* url invalide */ }
  }
  try {
    const x = new URL(r.product_link || r.link);
    if (x.protocol === "https:") return x.toString();
  } catch (e) { /* url invalide */ }
  return "";
}

export function pickOffers(results, query, { max = 5 } = {}) {
  const q = keyTokens(query);
  let kept = (results || [])
    .filter(r => r && Number(r.extracted_price) > 0 && r.source && r.title)
    .filter(r => !isMarketplace(r.source, r.link) && !isMarketplace(r.source, r.product_link))
    .filter(r => !isUsed(r, query))
    .filter(r => matches(q, r.title, query));
  if (!kept.length) return { offers: [], image: "", title: "" };

  // Avec au moins 3 prix, on écarte ceux qui s'éloignent trop de la médiane (accessoire, erreur, arnaque)
  if (kept.length >= 3) {
    const med = median(kept.map(r => Number(r.extracted_price)));
    kept = kept.filter(r => { const p = Number(r.extracted_price); return p >= med * 0.6 && p <= med * 1.8; });
  }

  const bestByStore = new Map();
  for (const r of kept) {
    const store = String(r.source).trim().slice(0, 60);
    const key = norm(store);
    const url = merchantUrl(r);
    if (!url) continue;
    const o = { store, price: Math.round(Number(r.extracted_price) * 100) / 100, url, shipping: shippingCost(r), r };
    const prev = bestByStore.get(key);
    if (!prev || totalOf(o) < totalOf(prev)) bestByStore.set(key, o);
  }
  const offers = [...bestByStore.values()].sort((a, b) => totalOf(a) - totalOf(b)).slice(0, max);
  if (!offers.length) return { offers: [], image: "", title: "" };

  const title = kept.map(r => String(r.title)).sort((a, b) => a.length - b.length)[0];
  let image = "";
  for (const o of offers) {
    const t = o.r.thumbnail;
    if (typeof t === "string" && t.startsWith("https://")) { image = t; break; }
  }
  return {
    offers: offers.map(({ store, price, url, shipping }) => ({ store, price, url, shipping })),
    image,
    title: title.slice(0, 120),
  };
}

export function looksLikeUrl(s) {
  const t = String(s ?? "").trim();
  if (/\s/.test(t)) return false;
  return /^https?:\/\//i.test(t) || /^([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(t);
}

// Le titre de la page (og:title) est parfois plus court que le titre du produit (« Drone X » au lieu de
// « Contrôleur de vol pour drone X ») : on prend le titre H1 s'il contient tous les mots du premier et en ajoute.
export function betterTitle(title, heading, store = "") {
  const t = cleanTitle(title, store), h = cleanTitle(heading, store);
  if (!h) return t;
  if (!t) return h;
  const ht = new Set(tokens(h)), tt = tokens(t);
  return tt.every(x => ht.has(x)) && ht.size > tt.length ? h : t;
}
