// Capture d'écran → cadeau prérempli. Un membre connecté envoie une capture (JPEG réduit par la page) ; Gemini la lit
// (nom, prix, couleur, taille, cadre de la photo), puis, si l'adresse n'est pas visible, cherche la page du produit (outil google_search).
// La capture n'est jamais enregistrée ni écrite dans les journaux. Rien n'est enregistré dans la liste : la page préremplit le formulaire.
// Variables : GEMINI_API_KEY (secret, posé par Dorian dans Coolify ; sans elle la fonction répond « off »), GEMINI_MODEL,
// GEMINI_FALLBACK_MODEL (secours, gemini-3.5-flash-lite par défaut),
// CAPTURE_DAY_MAX (plafond quotidien pour tout le site, 300 par défaut).
import { assertPublic, readMerchant } from "../noel-preview/net.ts";
import { API, extractRequest, hostOf, parseExtract, pickLink, searchRequest, searchSources } from "./gemini.js";

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function memberOf(token: string): Promise<number | null> {
  const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_ANON_KEY")!;
  const r = await fetch(`${url}/rest/v1/rpc/noel_home`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return typeof d?.me?.id === "number" ? d.me.id : null;
}

// Limites (en mémoire) : 20 appels à Gemini par membre et par heure, CAPTURE_DAY_MAX par jour pour tout le site
// (captures ET liens complétés par une recherche : noel-link utilise les mêmes compteurs)
const perMember = new Map<number, number[]>();
let day = "", dayCount = 0;
export function allowed(id: number, now = Date.now()): boolean {
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== day) { day = d; dayCount = 0; }
  if (dayCount >= Number(Deno.env.get("CAPTURE_DAY_MAX") || 300)) return false;
  const recent = (perMember.get(id) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= 20) return false;
  recent.push(now); perMember.set(id, recent); dayCount++;
  return true;
}

// Modèle principal, puis modèle de secours si le premier est surchargé, trop lent ou introuvable (vu le 28 novembre :
// les modèles Flash récents ne répondaient plus). Une erreur de clé ou de requête (400, 401, 403) n'est pas réessayée.
// quick (recherches Google) : le modèle léger d'abord, qui répond en 1 à 2 s et cherche bien quand la consigne l'impose.
export async function gemini(body: unknown, timeoutMs: number, quick = false): Promise<any> {
  const first = Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash";
  const backup = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-3.5-flash-lite";
  const models = first === backup ? [first] : quick ? [backup, first] : [first, backup];
  let error = "ai";
  for (let i = 0; i < models.length; i++) {
    const last = i === models.length - 1;
    // Ni clé ni contenu dans le journal : seulement le modèle et la raison
    const log = (why: string | number) => console.error(`noel-capture : Gemini ${models[i]} ${why}`);
    try {
      const r = await fetch(`${API}${encodeURIComponent(models[i])}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(last ? timeoutMs : Math.min(timeoutMs, 20_000)),
      });
      if (r.ok) return await r.json();
      log(r.status);
      try { await r.body?.cancel(); } catch (_) {}
      error = r.status === 429 ? "busy" : "ai";
      if (r.status !== 404 && r.status !== 429 && r.status < 500) break;
    } catch (e) {
      log((e as Error).name === "TimeoutError" ? "délai dépassé" : "injoignable");
      error = "busy";
    }
  }
  throw new Error(error);
}

// Lien de redirection d'une source Google → adresse finale (une seule étape, sans lire la page)
async function resolve(uri: string): Promise<string> {
  try {
    const u = new URL(uri);
    if (!/(^|\.)vertexaisearch\.cloud\.google\.com$/i.test(u.hostname)) return uri;
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    try { await r.body?.cancel(); } catch (_) {}
    const loc = r.headers.get("location");
    return loc ? new URL(loc, u).href : "";
  } catch (_) { return ""; }
}

async function findLink(info: { store: string; search: string; title: string }): Promise<string> {
  // Il arrive que le modèle réponde sans chercher (aucune source) : un second essai
  let found = searchSources(await gemini(searchRequest(info), 25_000, true));
  if (!found.chunks.length) found = searchSources(await gemini(searchRequest(info), 25_000, true));
  const { inText, chunks } = found;
  const resolved = (await Promise.all(chunks.slice(0, 6).map(async (c: { uri: string; title: string }) => ({ url: await resolve(c.uri), title: c.title }))))
    .filter((r) => r.url.startsWith("https://"));
  const link = pickLink(inText, resolved, info.store);
  if (!link) return "";
  try { await assertPublic(new URL(link)); } catch (_) { return ""; }   // jamais d'adresse interne
  return link;
}

export async function handler(req: Request): Promise<Response> {
  // La page demande si la lecture est activée, pour n'afficher le bouton que dans ce cas
  if (req.method === "GET") return json({ on: !!Deno.env.get("GEMINI_API_KEY") });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  if (!Deno.env.get("GEMINI_API_KEY")) return json({ error: "off" }, 503);
  const raw = await req.arrayBuffer();
  if (raw.byteLength > 2_500_000) return json({ error: "big" }, 413);
  let body: { token?: string; image?: string };
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { return json({ error: "invalid" }, 400); }
  const token = String(body?.token ?? ""), image = String(body?.image ?? "");
  if (!token || token.length > 100 || !/^[A-Za-z0-9+/]+=*$/.test(image) || image.length < 1000) return json({ error: "invalid" }, 400);
  const id = await memberOf(token);
  if (id == null) return json({ error: "session" }, 403);
  if (!allowed(id)) return json({ error: "throttled" }, 429);

  let info;
  try { info = parseExtract(await gemini(extractRequest(image), 45_000)); }
  catch (e) { return json({ error: (e as Error).message === "busy" ? "busy" : "ai" }, 502); }
  if (!info) { console.error("noel-capture : réponse de Gemini illisible"); return json({ error: "ai" }, 502); }
  if (!info.product || !info.title) return json({ error: "noproduct" }, 422);

  // Lien : celui de la capture s'il est lisible, sinon recherche Google
  let url = info.url, found = url ? "visible" : "";
  if (!url && (info.search || info.title)) {
    try { url = await findLink(info); found = url ? "search" : ""; } catch (_) { url = ""; }
  }
  // Page du produit : photo de meilleure qualité, et magasin. Le prix reste celui de la capture (ce que la personne a vu).
  let image_url = "", store = info.store;
  if (url) {
    const page = await readMerchant(url, 8000);
    if (page.info?.image && /^https:\/\//i.test(page.info.image)) image_url = page.info.image;
    store = hostOf(page.url || url) || store;
  }
  return json({
    title: info.title, price: info.price, color: info.color, size: info.size, details: info.details,
    store, url, found, image: image_url, box: info.box,
  });
}
