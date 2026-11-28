// Lit la page d'un lien collé par un membre connecté, pour préremplir son cadeau (nom, photo, prix, magasin).
// Une seule page lue, aucune recherche de prix, aucun accès SerpAPI. Protection contre les adresses internes : net.ts.
import { assertPublic, readMerchant } from "../noel-preview/net.ts";
import { nameFromUrl } from "./guess.js";
import { allowed as aiAllowed, gemini } from "../noel-capture/index.ts";
import { lookupRequest, parseLookup } from "../noel-capture/gemini.js";

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// Identifiant du membre si la session est valide, sinon null
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

// 30 lectures par membre et par quart d'heure (en mémoire)
const reads = new Map<number, number[]>();
function tooMany(id: number, now = Date.now()): boolean {
  const recent = (reads.get(id) ?? []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 30) return true;
  recent.push(now);
  reads.set(id, recent);
  return false;
}

// Adresse d'image proposée par la recherche : gardée seulement si c'est bien une image publique (aucune adresse interne)
async function isImage(u: string): Promise<boolean> {
  try {
    let url = new URL(u);
    for (let hop = 0; hop < 3; hop++) {
      await assertPublic(url);
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 (compatible; NoelFamille/1.0; +https://noel.dorianlab.fr)" } });
      try { await r.body?.cancel(); } catch (_) {}
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
      return r.status === 200 && /^image\/(jpeg|png|webp|avif|gif)/i.test(r.headers.get("content-type") || "");
    }
  } catch (_) {}
  return false;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { token?: string; url?: string };
  try { body = await req.json(); } catch (_) { return json({ error: "invalid" }, 400); }
  const token = String(body?.token ?? ""), link = String(body?.url ?? "").trim();
  if (!token || token.length > 100 || !/^https:\/\//i.test(link) || link.length > 2000) return json({ error: "invalid" }, 400);
  const id = await memberOf(token);
  if (id == null) return json({ error: "session" }, 403);
  if (tooMany(id)) return json({ error: "throttled" }, 429);
  const page = await readMerchant(link);
  const i = page.info;
  let title = i?.title || i?.name || "", image = i?.image && /^https:\/\//i.test(i.image) ? i.image : "", price: number | null = i?.price ?? null;
  let store = i?.store || "";
  if (!store) { try { store = new URL(page.url || link).hostname.replace(/^www\./, ""); } catch (_) {} }
  // Page illisible (mur anti-robots : Hollister, Amazon, Fnac…) ou incomplète : recherche Google par Gemini (si la clé est posée).
  // On ne contourne jamais le mur : ni faux navigateur, ni lecture de la page par un tiers ; seulement l'index de Google.
  let searched = false;
  if ((!title || price == null || !image) && Deno.env.get("GEMINI_API_KEY") && aiAllowed(id)) {
    try {
      const g = parseLookup(await gemini(lookupRequest(page.url || link, title || nameFromUrl(link)), 25_000));
      if (g) {
        if (!title && g.title) { title = g.title; searched = true; }
        if (price == null && g.price != null) { price = g.price; searched = true; }
        if (!image && g.image && await isImage(g.image)) { image = g.image; searched = true; }
      }
    } catch (_) { /* Gemini indisponible : on garde ce qu'on a */ }
  }
  // Toujours rien : nom deviné d'après l'adresse, signalé par `guessed`
  if (!title) return json({ title: nameFromUrl(page.url || link) || nameFromUrl(link), image, price, store, guessed: true, searched });
  return json({ title, image, price, store, searched });
}
