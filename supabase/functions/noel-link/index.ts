// Lit la page d'un lien collé par un membre connecté, pour préremplir son cadeau (nom, photo, prix, magasin).
// Une seule page lue, aucune recherche de prix, aucun accès SerpAPI. Protection contre les adresses internes : net.ts.
import { readMerchant } from "../noel-preview/net.ts";

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
  // Page illisible (Amazon, Fnac…) : réponse vide, le membre remplit à la main
  return json({
    title: i?.title || i?.name || "",
    image: i?.image || "",
    price: i?.price ?? null,
    store: i?.store || "",
  });
}
