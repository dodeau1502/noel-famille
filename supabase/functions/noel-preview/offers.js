// Choix des offres fiables à partir des résultats Google Shopping (SerpAPI)
const STOP = new Set(["de","la","le","les","du","des","un","une","et","pour","avec","sans","en","au","aux","the","a","of","and","for","with"]);

export function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
export function tokens(s) {
  return norm(s).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t));
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

// Mots-clés qui identifient le produit : marque + modèle (les premiers mots significatifs)
export function keyTokens(query, n = 5) {
  return tokens(query).slice(0, n);
}

export function score(queryTokens, title) {
  if (!queryTokens.length) return 0;
  const set = new Set(tokens(title));
  // Une référence chiffrée (modèle, taille, génération) doit correspondre exactement, sinon c'est un autre produit
  if (queryTokens.some(q => /\d/.test(q) && !set.has(q))) return 0;
  let hit = 0;
  for (const q of queryTokens) if (set.has(q)) hit++;
  return hit / queryTokens.length;
}

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
  let items = (results || [])
    .filter(r => r && Number(r.extracted_price) > 0 && r.source && r.title)
    .map(r => ({ r, s: score(q, r.title) }));
  let kept = items.filter(x => x.s >= 0.6);
  if (!kept.length) kept = items.filter(x => x.s >= 0.4).slice(0, 3);
  if (!kept.length) return { offers: [], image: "", title: "" };

  const med = median(kept.map(x => Number(x.r.extracted_price)));
  kept = kept.filter(x => {
    const p = Number(x.r.extracted_price);
    return p >= med * 0.4 && p <= med * 2.5;
  });

  const bestByStore = new Map();
  for (const x of kept) {
    const store = String(x.r.source).trim().slice(0, 60);
    const key = norm(store);
    const url = merchantUrl(x.r);
    if (!url) continue;
    const price = Math.round(Number(x.r.extracted_price) * 100) / 100;
    const prev = bestByStore.get(key);
    if (!prev || price < prev.price) bestByStore.set(key, { store, price, url, s: x.s, r: x.r });
  }
  const offers = [...bestByStore.values()].sort((a, b) => a.price - b.price).slice(0, max);
  if (!offers.length) return { offers: [], image: "", title: "" };

  const top = kept.slice().sort((a, b) => b.s - a.s)[0].r;
  let image = "";
  for (const o of offers) {
    const t = o.r.thumbnail;
    if (typeof t === "string" && t.startsWith("https://")) { image = t; break; }
  }
  return {
    offers: offers.map(({ store, price, url }) => ({ store, price, url })),
    image,
    title: String(top.title).slice(0, 120),
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
