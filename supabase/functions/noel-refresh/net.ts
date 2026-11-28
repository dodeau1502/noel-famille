// Lecture des pages des marchands (sans crédit SerpAPI). Partagé par noel-preview et noel-refresh.
import { extract, isPrivateIp, badHostname } from "./parse.js";
import { productRef, catalogRequest, infoFromCatalog } from "./shopify.js";

// En-tête honnête : se faire passer pour Chrome trahit un faux navigateur (l'empreinte réseau de Deno n'est pas celle de Chrome) et
// Cloudflare / Shopify répondent alors 429 à chaque lecture (constaté le 25 novembre : Greige, Mello, Sea to Summit).
const UA = "Mozilla/5.0 (compatible; NoelFamille/1.0; +https://noel.dorianlab.fr)";

export async function assertPublic(u: URL) {
  if (u.protocol !== "https:") throw new Error("Seuls les liens https sont acceptés.");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new Error("Lien non accepté.");
  if (badHostname(u.hostname)) throw new Error("Lien non accepté.");
  const ips: string[] = [];
  for (const t of ["A", "AAAA"] as const) {
    try { ips.push(...(await Deno.resolveDns(u.hostname, t))); } catch (_) { /* pas d'enregistrement de ce type */ }
  }
  if (!ips.length || ips.some(isPrivateIp)) throw new Error("Lien non accepté.");
}

export async function readLimited(res: Response, max = 1_500_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder("utf-8", { fatal: false });
  let out = "", total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= max) { try { await reader.cancel(); } catch (_) {} break; }
  }
  return out;
}

// Paramètres de suivi retirés des liens (le classement reste neutre, aucun lien affilié)
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|srsltid|gclid|fbclid|gad_|msclkid|aff|affiliate|awc|ranMID|ranEAID|ranSiteID|cid$)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch (_) { return raw; }
}

const BLOCKED = /just a moment|access denied|attention required|robot|captcha|maintenance|accès refusé|acces refuse|forbidden|are you a human|client challenge|checking your browser|verify you are human|un instant/i;

export type Page = { url: string; status: number; info: ReturnType<typeof extract> | null };

// Boutique Shopify : interface officielle d'abord (pas de page HTML à lire). L'adresse du profil est publiée par ce site (site/ucp-agent.json).
// null : pas une boutique Shopify, ou produit introuvable par cette voie -> lecture de la page. Un 429 ou un 403 est respecté : pas de repli.
async function readCatalog(raw: string, timeoutMs: number): Promise<Page | null> {
  const ref = productRef(raw);
  if (!ref) return null;
  try {
    const url = new URL(ref.origin + "/api/ucp/mcp");
    await assertPublic(url);
    let profile = "https://noel.dorianlab.fr/ucp-agent.json";
    try { profile = Deno.env.get("UCP_PROFILE") || profile; } catch (_) { /* pas d'accès à l'environnement */ }
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify(catalogRequest(ref, profile)),
    });
    if (res.status === 429 || res.status === 403) { await res.body?.cancel(); return { url: cleanUrl(raw), status: res.status, info: null }; }
    if (res.status !== 200 || !/json/i.test(res.headers.get("content-type") || "")) {
      // 404 : pas une boutique Shopify. Autre refus (profil illisible…) : on le note dans le journal.
      if (res.status !== 404) console.log("noel-diag " + JSON.stringify({ ucp: url.hostname, status: res.status }));
      await res.body?.cancel();
      return null;
    }
    const info = infoFromCatalog(JSON.parse(await readLimited(res)), ref);
    return info ? { url: cleanUrl(raw), status: 200, info } : null;
  } catch (_) {
    return null;
  }
}

// Lit la page d'un marchand. Ne lève jamais. Suit les redirections à la main (contrôle des adresses internes à chaque étape),
// ce qui résout aussi les liens Google « /goto?url=… ». info vaut null si la page est bloquée, illisible ou sans prix.
export async function readMerchant(raw: string, timeoutMs = 8000): Promise<Page> {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch (_) { return { url: raw, status: 0, info: null }; }
  let status = 0;
  const shop = await readCatalog(url.toString(), timeoutMs);
  if (shop) return shop;
  try {
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      await assertPublic(url);
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5" },
      });
      status = res.status;
      const loc = res.headers.get("location");
      if (status >= 300 && status < 400 && loc) { try { await res.body?.cancel(); } catch (_) {} url = new URL(loc, url); continue; }
      break;
    }
    const final = cleanUrl(url.toString());
    if (!res || status !== 200 || !/text\/html|application\/xhtml/i.test(res.headers.get("content-type") || "")) return { url: final, status, info: null };
    const html = await readLimited(res);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const info = extract(html, final);
    if (BLOCKED.test(title) && info.price == null) return { url: final, status, info: null };
    return { url: final, status, info };
  } catch (_) {
    return { url: cleanUrl(url.toString()), status, info: null };
  }
}

// Exécute des tâches en parallèle, au plus `limit` à la fois
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
