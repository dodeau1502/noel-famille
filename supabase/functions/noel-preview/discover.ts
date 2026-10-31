import { readMerchant, pool } from "./net.ts";
import { pickOffers, pickProduct, storesToOffers, mergeOffers, dropOutliers, betterTitle, looksLikeUrl, isMarketplace, totalOf, norm } from "./offers.js";
import { applyPage, bestOffer, rank } from "./verify.js";

export type Offer = { store: string; price: number; url: string; shipping?: number | null; verified?: boolean; at?: string; stock?: string; via?: string };

type Serp = { ok: boolean; data?: any; reason?: string };
// Une recherche SerpAPI = 1 crédit (les recherches en cache ou en échec ne comptent pas)
async function serp(params: Record<string, string>): Promise<Serp> {
  const key = Deno.env.get("SERPAPI_KEY");
  if (!key) return { ok: false, reason: "La recherche de prix n'est pas encore activée." };
  const u = new URL("https://serpapi.com/search.json");
  u.search = new URLSearchParams({ gl: "fr", hl: "fr", ...params, api_key: key }).toString();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (r.status === 429) return { ok: false, reason: "Limite mensuelle de recherches atteinte." };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "La clé du service de recherche est refusée." };
    if (!r.ok) return { ok: false, reason: "Le service de recherche ne répond pas." };
    return { ok: true, data: await r.json() };
  } catch (_) {
    return { ok: false, reason: "Le service de recherche ne répond pas." };
  }
}

function slugToText(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
    return decodeURIComponent(seg).replace(/\.(html?|php)$/i, "").replace(/[-_+]+/g, " ").replace(/\b[a-z]{0,2}\d{5,}\b/gi, "").trim();
  } catch (_) { return ""; }
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
const isGoogle = (u: string) => /(^|\.)google\.[a-z.]+$/i.test(hostOf(u));

// Pipeline complet : lecture de la page, recherche Google (2 recherches SerpAPI au plus, 3 avec le code-barres), vérification directe des marchands.
export async function discover(q: string, now = new Date(), opts: { token?: string; debug?: boolean } = {}) {
  let title = "", image = "", gtin = "";
  let searchText = q, pageOffer: Offer | null = null;

  // 1. Page du lien collé (titre, photo, prix, code-barres)
  if (looksLikeUrl(q)) {
    const page = await readMerchant(q);
    const info = page.info;
    if (info) {
      const market = isMarketplace(info.store, page.url || q); // place de marché : ni sa photo ni son prix
      title = betterTitle(info.title, info.heading, info.store);
      image = market ? "" : info.image;
      gtin = info.gtin;
      searchText = title || slugToText(page.url || q) || q;
      if (info.price != null && page.url && !market && info.stock !== "out") {
        pageOffer = { store: info.store || hostOf(page.url), price: info.price, url: page.url, shipping: null, verified: info.prices <= 1, at: now.toISOString(), stock: info.stock, via: "page" };
      }
    } else {
      searchText = slugToText(page.url || (/^https?:/i.test(q) ? q : "https://" + q)) || q;
    }
  }

  // 2. Google Shopping (1 recherche) : repère la fiche produit exacte, écarte accessoires et lots.
  //    Si le propriétaire a choisi un autre produit parmi les propositions (jeton), cette recherche est inutile.
  let searches = 0;
  let shop: Serp = { ok: true };
  let rows: any[] = [];
  let product: ReturnType<typeof pickProduct> = null;
  if (opts.token) {
    product = { token: opts.token, title: "", image: "", rows: [], alternatives: [] };
  } else {
    shop = await serp({ engine: "google_shopping", q: searchText.slice(0, 120), google_domain: "google.fr" });
    searches++;
    rows = shop.ok ? (shop.data?.shopping_results || []) : [];
    product = pickProduct(rows, searchText);
    // Sans résultat exploitable, le code-barres lu sur la page sert de seconde chance (1 recherche de plus)
    if (shop.ok && !product && gtin) {
      const s2 = await serp({ engine: "google_shopping", q: gtin, google_domain: "google.fr" });
      searches++;
      if (s2.ok) { rows = s2.data?.shopping_results || []; product = pickProduct(rows, searchText); }
    }
  }

  // 3. Fiche produit Google (1 recherche) : tous les marchands qui vendent exactement ce produit
  let storeOffers: Offer[] = [];
  let immReason = "";
  let rawStores: any[] = [];
  if (product?.token) {
    const imm = await serp({ engine: "google_immersive_product", page_token: product.token });
    searches++;
    if (imm.ok) {
      rawStores = imm.data?.product_results?.stores || [];
      storeOffers = storesToOffers(rawStores, searchText);
      if (!title && opts.token) title = String(imm.data?.product_results?.title || "").slice(0, 120);
    } else immReason = imm.reason || "";
  }
  // Les résultats de la liste plate ne servent que s'ils appartiennent à la fiche choisie
  const flat = pickOffers(product ? product.rows : rows, searchText).offers.map((o: Offer) => ({ ...o, via: "google" }));

  // 4. Candidats : la page collée fait foi pour son marchand, Google pour les autres
  const pageKey = pageOffer ? norm(pageOffer.store).replace(/[^a-z0-9]/g, "") : "";
  const google = dropOutliers(mergeOffers(storeOffers, flat)).filter((o: Offer) => !pageKey || norm(o.store).replace(/[^a-z0-9]/g, "") !== pageKey);
  let cands: Offer[] = mergeOffers(google, pageOffer ? [pageOffer] : []).sort((a: Offer, b: Offer) => totalOf(a) - totalOf(b));

  // 5. Vérification gratuite : lecture directe des pages des 5 offres les moins chères
  const top = cands.slice(0, 5);
  const checked = await pool(top, 5, async (o: Offer) => {
    if (o.via === "page") return o;
    const page = await readMerchant(o.url);
    const out = applyPage(o, page.info, searchText, now);
    if (page.url && !isGoogle(page.url)) out.url = page.url; // lien direct du marchand à la place du lien Google
    return out;
  });
  cands = [...checked, ...cands.slice(5)];

  // un même site ne compte qu'une fois
  const byHost = new Map<string, Offer>();
  for (const o of cands) {
    const h = isGoogle(o.url) ? "g:" + norm(o.store) : hostOf(o.url);
    const prev = byHost.get(h);
    if (!prev || totalOf(o) < totalOf(prev)) byHost.set(h, o);
  }
  const offers: Offer[] = rank([...byHost.values()]).slice(0, 6);
  const best = bestOffer(offers);

  if (!title) title = product?.title || (looksLikeUrl(q) ? searchText : q);
  if (!image) image = product?.image || "";
  const price = best ? best.price : null, store = best ? best.store : "";

  const gotSomething = !!(image || price != null || offers.length);
  return {
    ok: gotSomething || !!title,
    title: title.slice(0, 120), image, price, store, gtin, offers,
    searched: shop.ok, searches,
    token: product?.token || "",
    alternatives: product && product.alternatives.length > 1 ? product.alternatives.map((a) => ({ token: a.token, title: a.title, image: a.image, price: a.price })) : [],
    ...(opts.debug ? { debug: {
      rows: rows.length, stores: storeOffers.length, flat: flat.length,
      sample: rows.slice(0, 14).map((r: any) => [r.source, r.extracted_price, String(r.title || "").slice(0, 70)]),
      groups: product?.alternatives.map((a) => [a.count, a.extras, a.price, a.title.slice(0, 60)]),
      rawStores: rawStores.slice(0, 12).map((x: any) => [x.name, String(x.title || "").slice(0, 50), x.extracted_price, x.shipping, String(x.link || "").slice(0, 30)]),
    } } : {}),
    reason: shop.ok ? (offers.length ? undefined : (immReason || "Aucun marchand trouvé pour ce produit.")) : shop.reason,
  };
}
