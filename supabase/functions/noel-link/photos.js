// Recherche d'images (SerpAPI, moteur google_images) quand un lien n'a donné aucune photo. Partie pure, testée par photos.test.mjs.
import { hostOf, httpsUrl } from "../noel-capture/gemini.js";

const SKIP = /(^|\.)(pinterest\.[a-z.]+|pinimg\.com|facebook\.com|fbsbx\.com|instagram\.com|tiktok\.com|youtube\.com|ytimg\.com|reddit\.com|redd\.it)$/i;
// « hollisterco.com » → « hollisterco », « shop.lego.co.uk » → « lego »
export const brandOf = (link) => { const p = hostOf(link).split("."); return p.length > 2 && p[p.length - 2].length <= 3 ? p[p.length - 3] : p[p.length - 2] || ""; };

// Ce qu'on cherche : le nom, complété du magasin ; à défaut de nom, la référence Amazon de l'adresse. Vide = pas de recherche.
export function imageQuery(title, color, link) {
  const asin = (String(link).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?#]|$)/) || [])[1] || "";
  const base = String(title || "").trim() || asin;
  if (!base) return "";
  const brand = brandOf(link);
  const extra = [color, brand].filter((w) => w && !base.toLowerCase().includes(String(w).toLowerCase()));
  return [base, ...extra].join(" ").slice(0, 200);
}

export const searchUrl = (q, key) =>
  "https://serpapi.com/search.json?" + new URLSearchParams({ engine: "google_images", q, hl: "fr", gl: "fr", safe: "active", api_key: key });

// Adresses d'images à essayer : celles venues du magasin du lien d'abord, puis l'ordre de Google
export function candidates(data, link, max = 12) {
  const brand = brandOf(link);
  const list = (Array.isArray(data?.images_results) ? data.images_results : [])
    .map((r) => ({ url: httpsUrl(r?.original || ""), page: httpsUrl(r?.link || "") }))
    .filter((r) => r.url && r.url.length <= 2000 && !SKIP.test(hostOf(r.url)) && !SKIP.test(hostOf(r.page)));
  const same = (r) => !!brand && (brandOf(r.page) === brand || brandOf(r.url) === brand);
  return [...new Set([...list.filter(same), ...list.filter((r) => !same(r))].map((r) => r.url))].slice(0, max);
}
