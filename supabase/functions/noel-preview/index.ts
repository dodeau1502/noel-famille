import { discover } from "./discover.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { code?: string; query?: string; url?: string; token?: string };
  try { body = await req.json(); } catch (_) { return json({ error: "requête invalide" }, 400); }
  const code = String(body.code ?? "");
  const q = String(body.query ?? body.url ?? "").trim();
  if (!code || !q || q.length > 500) return json({ error: "requête invalide" }, 400);
  if (!(await isOwner(code))) return json({ error: "non autorisé" }, 403);
  // « token » : le propriétaire a choisi une autre fiche produit parmi les propositions (1 seule recherche SerpAPI)
  const token = typeof body.token === "string" && body.token.length > 0 && body.token.length < 1200 ? body.token : undefined;
  return json(await discover(q, new Date(), { token }));
});
