// Actualisation gratuite des prix : relit les pages des marchands déjà connues (aucun crédit SerpAPI).
// Deux usages : le planning automatique de la base ({cron:true}) et le bouton du propriétaire ({code, id}).
// Confidentialité : le choix des fiches ne dépend que de la date de dernière lecture (checked_at), jamais des réservations.
import { readMerchant, pool } from "./net.ts";
import { totalOf } from "./offers.js";
import { applyPage, bestOffer, rank } from "./verify.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };

const CRON_MIN_AGE_MS = 20 * 3600_000;   // une lecture par jour et par fiche
const OWNER_MIN_AGE_MS = 10 * 60_000;    // le bouton du propriétaire ne martèle pas les marchands
const CRON_BATCH = 3;

async function isOwner(code: string): Promise<boolean> {
  const r = await fetch(`${URL_}/rest/v1/rpc/noel_get`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: code }),
  });
  if (!r.ok) return false;
  const d = await r.json().catch(() => null);
  return d?.role === "owner";
}

type Gift = { id: number; title: string; offers: any[] | null; checked_at: string | null };

async function refreshGift(g: Gift, now: Date) {
  const offers = Array.isArray(g.offers) ? g.offers.filter((o) => o && typeof o.url === "string" && o.price > 0) : [];
  const updated = await pool(offers, 4, async (o) => {
    const page = await readMerchant(o.url);
    const out = applyPage(o, page.info, g.title, now);
    let host = "google.fr";
    try { host = new URL(page.url).hostname; } catch (_) { /* adresse illisible : on garde l'ancienne */ }
    if (!/(^|\.)google\.[a-z.]+$/i.test(host)) out.url = page.url;
    return out;
  });
  const ranked = rank(updated);
  const best = bestOffer(ranked);
  const patch: Record<string, unknown> = { checked_at: now.toISOString() };
  if (ranked.length) {
    patch.offers = ranked; patch.offers_at = now.toISOString();
    if (best) { patch.price = best.price; patch.store = best.store; }
  }
  await fetch(`${URL_}/rest/v1/noel_gifts?id=eq.${g.id}`, { method: "PATCH", headers: H, body: JSON.stringify(patch) });

  // Historique : un point par jour au plus (ou dès que le meilleur prix change)
  if (best) {
    const total = totalOf(best);
    const last = await fetch(`${URL_}/rest/v1/noel_prices?gift_id=eq.${g.id}&order=at.desc&limit=1&select=price,at`, { headers: H }).then((r) => r.json()).catch(() => []);
    const l = Array.isArray(last) ? last[0] : null;
    const sameDay = l && now.getTime() - new Date(l.at).getTime() < 20 * 3600_000;
    if (!l || Number(l.price) !== total || !sameDay) {
      await fetch(`${URL_}/rest/v1/noel_prices`, {
        method: "POST", headers: { ...H, Prefer: "return=minimal" },
        body: JSON.stringify({ gift_id: g.id, price: total, store: best.store, verified: !!best.verified, at: now.toISOString() }),
      });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { cron?: boolean; code?: string; id?: number };
  try { body = await req.json(); } catch (_) { return json({ error: "requête invalide" }, 400); }
  const now = new Date();
  let gifts: Gift[] = [];

  if (body.cron === true) {
    // Les fiches les moins récemment lues d'abord. Aucune lecture des réservations.
    const cut = new Date(now.getTime() - CRON_MIN_AGE_MS).toISOString();
    const q = `${URL_}/rest/v1/noel_gifts?select=id,title,offers,checked_at&or=(checked_at.is.null,checked_at.lt.${cut})&order=checked_at.asc.nullsfirst,id.asc&limit=${CRON_BATCH}`;
    gifts = await fetch(q, { headers: H }).then((r) => r.json()).catch(() => []);
  } else {
    const code = String(body.code ?? ""), id = Number(body.id);
    if (!code || !Number.isInteger(id)) return json({ error: "requête invalide" }, 400);
    if (!(await isOwner(code))) return json({ error: "non autorisé" }, 403);
    const cut = new Date(now.getTime() - OWNER_MIN_AGE_MS).toISOString();
    const q = `${URL_}/rest/v1/noel_gifts?select=id,title,offers,checked_at&id=eq.${id}&or=(checked_at.is.null,checked_at.lt.${cut})&limit=1`;
    gifts = await fetch(q, { headers: H }).then((r) => r.json()).catch(() => []);
  }
  if (!Array.isArray(gifts)) gifts = [];
  for (const g of gifts) { try { await refreshGift(g, now); } catch (_) { /* une fiche en échec ne bloque pas les autres */ } }
  return json({ ok: true, n: gifts.length });
});
