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

// Référence d'une pièce incluse dans un lot (« Fly More Combo RC-N3 » : la radiocommande). Google et beaucoup de marchands ne la
// citent pas dans leurs titres : l'exiger écartait presque toutes les offres (cas réel, DJI Lito X1). Elle n'est facultative que si
// elle suit un mot de lot (combo, pack, bundle, kit…) : une référence de modèle (« WH-1000XM5 », « X-T5 ») reste obligatoire.
const BUNDLE_WORDS = new Set(["combo","pack","bundle","kit","set","coffret","lot"]);
export function optionalTokens(query) {
  const q = norm(query), out = new Set();
  const re = /\b[a-z]{1,4}-[a-z]?\d[a-z0-9]*\b/g;
  let m;
  while ((m = re.exec(q))) {
    if (tokens(q.slice(0, m.index)).some(t => BUNDLE_WORDS.has(t))) tokens(m[0]).forEach(t => out.add(t));
  }
  return out;
}

// Mots-clés qui identifient le produit : les premiers mots significatifs + TOUTES les références chiffrées de la requête
export function keyTokens(query, n = 6) {
  const opt = optionalTokens(query);
  const all = tokens(query).filter(t => !COLORS.has(t) && !opt.has(t));
  const first = all.slice(0, n);
  const digits = all.filter(t => /\d/.test(t) && !first.includes(t));
  return [...first, ...digits].slice(0, 9);
}

// Mots qui font un produit différent (version, lot) : l'ensemble doit être identique dans la requête et dans le résultat
const VARIANTS = new Set(["pro","max","plus","ultra","lite","mini","xl","slim","combo","bundle","pack","kit","adventure","standard","creator","essential","edition"]);
const variantSet = s => [...new Set(tokens(s).filter(t => VARIANTS.has(t)))].sort().join(",");

// Distance d'édition ≤ 1 (« millenium » / « millennium »)
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// Le mot-clé est-il dans le titre ? Tolère « WH1000XM5 » pour « WH 1000XM5 » (référence collée) et une faute d'une lettre sur un mot long
function has(set, compact, tok) {
  if (set.has(tok)) return true;
  if (tok.length >= 4 && /\d/.test(tok) && /[a-z]/.test(tok) && new RegExp("(^|[^0-9])" + tok + "($|[^0-9])").test(compact)) return true;
  if (tok.length >= 7 && !/\d/.test(tok)) { for (const t of set) if (near(tok, t)) return true; }
  return false;
}
const compactOf = title => norm(title).replace(/[^a-z0-9]+/g, "");
// Mots du titre ; une référence collée (« wh1000xm5 ») donne aussi « wh » et « 1000xm5 »
function wordSet(title) {
  const set = new Set(tokens(title));
  for (const t of [...set]) { const m = t.match(/^([a-z]+)(\d.*)$/); if (m) { set.add(m[1]); set.add(m[2]); } }
  return set;
}

// Un résultat correspond seulement si TOUS les mots-clés sont présents et que la version est la même
export function matches(queryTokens, title, query = "") {
  if (!queryTokens.length) return false;
  const set = wordSet(title), compact = compactOf(title);
  // Une référence numérique longue (« 75192 ») identifie le produit : elle et la marque (premier mot) suffisent
  const ref = queryTokens.find(t => /^\d{5,}$/.test(t));
  const needed = ref ? [queryTokens[0], ref] : queryTokens;
  if (!needed.every(q => has(set, compact, q))) return false;
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
const MARKET = ["leboncoin","vinted","ebay","backmarket","facebook","marketplace","cashconverters","easycash","rakuten","aliexpress","alibaba","temu","rebuy","momox","recommerce","etsy","shein","olx","ricardo","kleinanzeigen","2ememain","ubuy","onbuy","beebs","wish","joom","banggood","dhgate","brickowl","bricklink","stockx","madeinchina","seller","vendeur"];
// Comparateurs de prix : ce ne sont pas des marchands, on ne les présente jamais comme une offre
const COMPARATOR = ["achatmoinscher","kulturegeek","idealo","kelkoo","leguide","shopzilla","pricerunner","dealabs","pricespy","twenga","shopmania","googleshopping","comparer"];
export function isComparator(store, url = "") {
  const s = norm(store).replace(/[^a-z0-9]/g, "");
  let h = "";
  try { h = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, ""); } catch (e) { /* url invalide */ }
  return COMPARATOR.some(m => s.includes(m) || (h && h.includes(m)));
}
export function isMarketplace(store, url = "") {
  const raw = String(store ?? "").trim();
  const s = norm(raw).replace(/[^a-z0-9]/g, "");
  let h = "";
  try { h = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, ""); } catch (e) { /* url invalide */ }
  if (MARKET.some(m => s.includes(m) || (h && h.includes(m)))) return true;
  if (isComparator(store, url)) return true;
  // Identifiant de vendeur (« foto-erhardtfr ») : tout en minuscules avec tiret, sans point ni espace
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(raw);
}

// Accessoires, jeux et lots : ils contiennent le nom du produit mais ne sont pas le produit
const ACCESSORY = new Set(["coque","coques","etui","etuis","housse","housses","pochette","protection","protections","protege","films","film","verre","trempe","support","supports","fixation","cable","cables","chargeur","chargeurs","batterie","batteries","adaptateur","adaptateurs","filtre","filtres","accessoire","accessoires","vitrine","display","case","cover","sangle","bandouliere","trepied","poignee","lanyard","coussinet","coussinets","rechange","remplacement","sticker","stickers","skin","socle","manette","manettes","telecommande","pour","compatible","compatibles","for"]);
// Ces mots décrivent aussi le contenu d'un lot (« Combo à deux batteries », « avec chargeur ») : ils ne font un accessoire
// que s'ils ne sont pas introduits par un nombre ou « avec / à / inclus » (« Batterie 3.8V pour XM5 » reste un accessoire).
const AMBIGUOUS = new Set(["batterie","batteries","chargeur","chargeurs","cable","cables","adaptateur","adaptateurs","support","supports","filtre","filtres","manette","manettes","telecommande","accessoire","accessoires"]);
const INCLUDED = /^(avec|a|deux|trois|quatre|une|un|inclus|incluant|inclut|double|plusieurs|\d+|x\d+|\d+x)$/;
export function isAccessory(title, query = "") {
  const q = new Set(norm(query).split(/[^a-z0-9]+/));
  const t = norm(title).split(/[^a-z0-9]+/);
  if (t.some((w, i) => ACCESSORY.has(w) && !q.has(w) && !(AMBIGUOUS.has(w) && INCLUDED.test(t[i - 1] || "")))) return true;
  return /\s\+\s/.test(title) && !/\+/.test(query); // « produit + autre chose » : lot
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
    .filter(r => !isAccessory(r.title, query))
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

const round2 = n => Math.round(n * 100) / 100;

// Mots de catégorie sans valeur d'identification (« Console Nintendo Switch 2 », « Casque Sony XM5 »)
const GENERIC = new Set(["console","casque","ecouteurs","ecouteur","liseuse","ebook","camera","appareil","photo","ecran","sans","fil","bluetooth","wifi","reduction","bruit","portable","consoles","jeu","video","smart","connecte","connectee","numerique","electrique","enceinte","aspirateur","robot","montre"]);
const extrasOf = (title, qset) => tokens(title).filter(t => !qset.has(t) && !COLORS.has(t) && !GENERIC.has(t)).length;

// Choisit la fiche produit Google (jeton « immersive ») qui correspond le mieux à la requête,
// en ignorant accessoires, lots, occasion et prix hors norme. Le produit dont le titre ressemble le plus à la requête
// l'emporte (« Console Switch 2 » avant « Mario Kart – Switch 2 ») ; les autres candidats sont renvoyés pour que le propriétaire puisse choisir.
export function pickProduct(results, query) {
  const q = keyTokens(query), qset = new Set(tokens(query));
  let ok = (results || []).filter(r => r && r.title && Number(r.extracted_price) > 0 && !isUsed(r, query) && !isAccessory(r.title, query) && matches(q, r.title, query));
  if (!ok.length) return null;
  const thumb = rows => (rows.map(r => r.thumbnail).find(t => typeof t === "string" && t.startsWith("https://"))) || "";
  const shortest = rows => rows.map(r => String(r.title)).sort((a, b) => a.length - b.length)[0].slice(0, 120);
  const withTok = ok.filter(r => typeof r.immersive_product_page_token === "string" && r.immersive_product_page_token);
  if (!withTok.length) {
    if (ok.length >= 3) {
      const med = median(ok.map(r => Number(r.extracted_price)));
      ok = ok.filter(r => { const p = Number(r.extracted_price); return p >= med * 0.6 && p <= med * 1.8; });
    }
    return { token: "", title: shortest(ok), image: thumb(ok), rows: ok, alternatives: [], backups: [] };
  }
  const groups = new Map();
  for (const r of withTok) {
    const g = groups.get(r.immersive_product_page_token) || { token: r.immersive_product_page_token, rows: [] };
    g.rows.push(r); groups.set(r.immersive_product_page_token, g);
  }
  const list = [...groups.values()].map((g, order) => {
    const prices = g.rows.map(r => Number(r.extracted_price));
    const extras = Math.min(...g.rows.map(r => extrasOf(r.title, qset)));
    return { ...g, order, count: g.rows.length, extras, price: round2(median(prices)), score: g.rows.length - 2 * extras };
  });
  list.sort((a, b) => b.score - a.score || a.order - b.order);   // égalité : premier résultat de Google
  const best = list[0];
  // Une proposition par « signature » (mots en plus de la requête) : plusieurs vendeurs du même produit ne sont pas des alternatives
  const sig = g => [...new Set(g.rows.flatMap(r => tokens(r.title)).filter(t => !qset.has(t) && !COLORS.has(t) && !GENERIC.has(t)))].sort().join(" ");
  const seen = new Set(), alts = [];
  for (const g of list) {
    if (g !== best && !(g.price >= best.price * 0.5 && g.price <= best.price * 2)) continue;
    const k = g.extras === 0 ? "" : sig(g);
    if (seen.has(k)) continue;
    seen.add(k); alts.push(g);
  }
  // Fiches de secours (2 au plus) : les autres fiches qui passent le même filtre strict, sans mot en trop de plus que la fiche choisie
  // (pas de pack plus spécifique) et dans la même fourchette de prix. Elles ne servent que si la première fiche donne peu de marchands
  // (discover.ts) : une recherche de plus à chaque fois.
  const backups = list.filter(g => g !== best && g.extras <= best.extras && g.price >= best.price * 0.5 && g.price <= best.price * 2).map(g => g.token);
  return {
    token: best.token, title: shortest(best.rows), image: thumb(best.rows) || thumb(ok), rows: best.rows,
    alternatives: alts.slice(0, 4).map(g => ({ token: g.token, title: shortest(g.rows), image: thumb(g.rows), price: g.price, count: g.count, extras: g.extras })),
    backups: backups.slice(0, 2),
  };
}

// Écarte une offre dont le prix s'éloigne trop de celui des autres (au moins 2 autres offres) ; les offres « via: page » sont conservées
export function dropOutliers(offers) {
  return (offers || []).filter(o => {
    if (o.via === "page") return true;
    const others = offers.filter(x => x !== o).map(x => x.price);
    if (others.length < 2) return true;
    const med = median(others);
    return o.price >= med * 0.6 && o.price <= med * 1.8;
  });
}

// Correspondance tolérante (fiche produit déjà identifiée par Google) : mêmes chiffres, même version (sauf variants:false), 60 % des mots
export function matchesLoose(query, title, { variants = true } = {}) {
  const q = keyTokens(query), t = wordSet(title), compact = compactOf(title);
  if (!q.length) return false;
  if (!q.filter(x => /\d/.test(x)).every(x => has(t, compact, x))) return false;
  if (variants && variantSet(title) !== variantSet(query)) return false;
  const words = q.filter(x => !/\d/.test(x));
  return !words.length || words.filter(x => has(t, compact, x)).length / words.length >= 0.6;
}

// Marchands de la fiche produit Google (google_immersive_product) -> offres
export function storesToOffers(stores, query, { max = 8 } = {}) {
  const base = "https://www.google.fr";
  let list = [];
  for (const s of stores || []) {
    if (!s || !s.name) continue;
    const price = Number(s.extracted_price);
    if (!(price > 0)) continue;
    let url = "";
    try { const u = new URL(String(s.link || ""), base); if (u.protocol === "https:") url = u.toString(); } catch (e) { /* lien invalide */ }
    if (!url) continue;
    const store = String(s.name).trim().slice(0, 60);
    if (isMarketplace(store, url)) continue;
    const info = [s.title, ...(Array.isArray(s.details_and_offers) ? s.details_and_offers : [])].filter(Boolean).join(" ");
    if (isUsed({ title: info, second_hand_condition: s.second_hand_condition }, query)) continue;
    if (s.title && !matchesLoose(query, s.title, { variants: false })) continue;
    let shipping = shippingCost({ delivery: s.shipping });
    const total = Number(s.extracted_total);
    if (shipping === null && total > price && total - price < price) shipping = round2(total - price);
    list.push({ store, price: round2(price), url, shipping, via: "google" });
  }
  if (list.length >= 3) {
    const med = median(list.map(o => o.price));
    list = list.filter(o => o.price >= med * 0.6 && o.price <= med * 1.8);
  }
  const byStore = new Map();
  for (const o of list) {
    const k = norm(o.store);
    const prev = byStore.get(k);
    if (!prev || totalOf(o) < totalOf(prev)) byStore.set(k, o);
  }
  return [...byStore.values()].sort((a, b) => totalOf(a) - totalOf(b)).slice(0, max);
}

// Fusionne des listes d'offres : une seule offre par marchand (la moins chère, la vérifiée l'emporte à prix égal)
export function mergeOffers(...lists) {
  const byStore = new Map();
  for (const o of lists.flat()) {
    if (!o || !o.store || !(o.price > 0) || !o.url) continue;
    const k = norm(o.store).replace(/[^a-z0-9]/g, "");
    const prev = byStore.get(k);
    if (!prev || totalOf(o) < totalOf(prev) || (totalOf(o) === totalOf(prev) && o.verified && !prev.verified)) byStore.set(k, o);
  }
  return [...byStore.values()];
}
