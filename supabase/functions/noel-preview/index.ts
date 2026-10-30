import { extract, isPrivateIp, badHostname } from "./parse.js";
import { pickOffers, cleanTitle, betterTitle, looksLikeUrl } from "./offers.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Offer = { store: string; price: number; url: string };

async function isOwner(code: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_ANON_KEY")!;
  const r = await fetch(`${url}/rest/v1/rpc/noel_get`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: code }),
  });
  if (!r.ok) return false;
  const d = await r.json().catch(() => null);
  return d?.role === "owner";
}

async function assertPublic(u: URL) {
  if (u.protocol !== "https:") throw new Error("Seuls les liens https sont acceptés.");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new Error("Lien non accepté.");
  if (badHostname(u.hostname)) throw new Error("Lien non accepté.");
  const ips: string[] = [];
  for (const t of ["A", "AAAA"] as const) {
    try { ips.push(...(await Deno.resolveDns(u.hostname, t))); } catch (_) { /* pas d'enregistrement de ce type */ }
  }
  if (!ips.length || ips.some(isPrivateIp)) throw new Error("Lien non accepté.");
}

async function readLimited(res: Response, max = 1_500_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder("utf-8", { fatal: false });
  let out = "", total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= max || (/<\/head>/i.test(out) && total > 200_000)) { try { await reader.cancel(); } catch (_) {} break; }
  }
  return out;
}

// Lit la page d'un magasin (titre, photo, prix). Ne lève jamais : renvoie null si la lecture échoue.
async function readPage(raw: string) {
  try {
    let url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublic(url);
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url); continue; }
      break;
    }
    if (!res || !res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get("content-type") || "")) return { url: url.toString(), info: null };
    return { url: url.toString(), info: extract(await readLimited(res), url.toString()) };
  } catch (_) {
    return { url: "", info: null };
  }
}

// Recherche des offres chez plusieurs marchands (Google Shopping via SerpAPI)
async function searchOffers(q: string): Promise<{ ok: boolean; reason?: string; offers: Offer[]; image: string; title: string }> {
  const key = Deno.env.get("SERPAPI_KEY");
  if (!key) return { ok: false, reason: "La recherche de prix n'est pas encore activée.", offers: [], image: "", title: "" };
  const u = new URL("https://serpapi.com/search.json");
  u.search = new URLSearchParams({ engine: "google_shopping", q: q.slice(0, 120), gl: "fr", hl: "fr", google_domain: "google.fr", api_key: key }).toString();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (r.status === 429) return { ok: false, reason: "Limite mensuelle de recherches atteinte.", offers: [], image: "", title: "" };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "La clé du service de recherche est refusée.", offers: [], image: "", title: "" };
    if (!r.ok) return { ok: false, reason: "Le service de recherche ne répond pas.", offers: [], image: "", title: "" };
    const d = await r.json();
    const p = pickOffers(d.shopping_results || [], q);
    return { ok: true, ...p };
  } catch (_) {
    return { ok: false, reason: "Le service de recherche ne répond pas.", offers: [], image: "", title: "" };
  }
}

function slugToText(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
    return decodeURIComponent(seg).replace(/\.(html?|php)$/i, "").replace(/[-_+]+/g, " ").replace(/\b[a-z]{0,2}\d{5,}\b/gi, "").trim();
  } catch (_) { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { code?: string; query?: string; url?: string };
  try { body = await req.json(); } catch (_) { return json({ error: "requête invalide" }, 400); }
  const code = String(body.code ?? "");
  const q = String(body.query ?? body.url ?? "").trim();
  if (!code || !q || q.length > 500) return json({ error: "requête invalide" }, 400);
  if (!(await isOwner(code))) return json({ error: "non autorisé" }, 403);

  let title = "", image = "", price: number | null = null, store = "";
  let searchText = q, pageOffer: Offer | null = null;

  if (looksLikeUrl(q)) {
    const { url, info } = await readPage(q);
    if (info) {
      store = info.store;
      title = betterTitle(info.title, info.heading, info.store);
      image = info.image;
      price = info.price;
      searchText = title || slugToText(url || q) || q;
      if (info.price != null && url) pageOffer = { store: info.store || new URL(url).hostname.replace(/^www\./, ""), price: info.price, url };
    } else {
      searchText = slugToText(url || (/^https?:/i.test(q) ? q : "https://" + q)) || q;
    }
  }

  const found = await searchOffers(searchText);
  let offers = found.offers.slice();
  if (pageOffer && !offers.some((o) => o.store.toLowerCase() === pageOffer!.store.toLowerCase())) offers.push(pageOffer);
  offers.sort((a, b) => a.price - b.price);
  offers = offers.slice(0, 5);

  if (!title) title = found.title || (looksLikeUrl(q) ? searchText : q);
  if (!image) image = found.image;
  if (offers.length) { price = offers[0].price; store = offers[0].store; }

  const gotSomething = !!(image || price != null || offers.length);
  return json({
    ok: gotSomething || !!title,
    title: title.slice(0, 120), image, price, store, offers,
    searched: found.ok,
    reason: found.ok ? (offers.length ? undefined : "Aucun marchand trouvé pour ce produit.") : found.reason,
  });
});
