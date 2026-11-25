// Actualisation gratuite des prix : relit les pages des marchands déjà connues (aucun crédit SerpAPI).
// Deux usages : le planning automatique de la base ({cron:true}) et le bouton du propriétaire ({code, id}).
// Confidentialité : le choix des fiches ne dépend que de next_check_at (calculé par schedule.js à partir de données publiques : pistes, relevés,
// période forte, nombre d'offres lisibles), jamais des réservations ni de noel_claims.
// Le radar (noel-radar) demande une relecture en posant next_check_at = now : le déclencheur est un deal public, jamais une réservation.
import { readMerchant, pool } from "./net.ts";
import { applyPage } from "./verify.js";
import { saveOffers } from "./save.ts";
import { DomainThrottle, hostOf, inHighPeriod, lastChange, nextCheck, offerDue, readableCount, takeReads } from "./schedule.js";

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

// Lot P : la prochaine lecture de chaque fiche est calculée par nextCheck (de 15 min à 6 h). Plafonds : REFRESH_MAX_READS_H lectures par heure (défaut 120),
// 1 lecture toutes les 20 s et 60 par heure et par domaine. HIGH_PERIODS : périodes de promotions fortes.
const maxReads = Number(Deno.env.get("REFRESH_MAX_READS_H"));
const MAX_READS_H = Number.isFinite(maxReads) && maxReads >= 1 ? maxReads : 120;
const HIGH_PERIODS = Deno.env.get("HIGH_PERIODS") ?? "2026-11-27/2026-12-01,2026-12-14/2026-12-24";
const throttle = new DomainThrottle();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

type Gift = { id: number; title: string; offers: any[] | null; checked_at: string | null };

// Compteur global de lectures par heure (noel_sources « refresh » : last_item_at = début de fenêtre, items_last = lectures)
async function takeGlobal(want: number, now: Date): Promise<number> {
  const rows = await fetch(`${URL_}/rest/v1/noel_sources?name=eq.refresh&select=last_item_at,items_last`, { headers: H }).then((r) => r.json()).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  const { allowed, src } = takeReads(row ? { window_start: row.last_item_at, n: row.items_last } : null, want, MAX_READS_H, now);
  await fetch(`${URL_}/rest/v1/noel_sources?on_conflict=name`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ name: "refresh", last_ok: now.toISOString(), last_item_at: src.window_start, items_last: src.n }),
  }).catch(() => {});
  return allowed;
}

// Prochaine lecture d'une fiche : uniquement des données publiques (pistes acceptées, relevés vérifiés, offres, période)
async function planNext(g: Gift, offers: any[], now: Date) {
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const sig = await fetch(`${URL_}/rest/v1/noel_signals?gift_id=eq.${g.id}&status=eq.accepted&select=seen_at&order=seen_at.desc&limit=1`, { headers: H }).then((r) => r.json()).catch(() => []);
  const obs = await fetch(`${URL_}/rest/v1/noel_observations?gift_id=eq.${g.id}&verified=is.true&at=gte.${since}&select=mkey,total,verified,at&order=at.asc&limit=500`, { headers: H }).then((r) => r.json()).catch(() => []);
  const at = nextCheck({
    lastSignalAt: Array.isArray(sig) && sig[0] ? sig[0].seen_at : null,
    lastChangeAt: lastChange(Array.isArray(obs) ? obs : []),
    readableCount: readableCount(offers),
    inHighPeriod: inHighPeriod(now, HIGH_PERIODS),
  }, now);
  await fetch(`${URL_}/rest/v1/noel_gifts?id=eq.${g.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ next_check_at: at.toISOString() }) });
}

// force : bouton du propriétaire (relit même les offres en échec, sans plafond). Sinon : plafonds global et par domaine.
async function refreshGift(g: Gift, now: Date, force = false) {
  const offers = Array.isArray(g.offers) ? g.offers.filter((o) => o && typeof o.url === "string" && o.price > 0) : [];
  let budget = force ? Infinity : await takeGlobal(offers.filter((o) => offerDue(o, now)).length, now);
  const updated = await pool(offers, 4, async (o) => {
    if (!offerDue(o, now, force)) return o;
    if (!force) {
      if (budget <= 0) return o;
      budget--;
      const wait = throttle.reserve(hostOf(o.url), Date.now());
      if (wait < 0) return o;
      if (wait > 0) await sleep(wait);
    }
    const page = await readMerchant(o.url);
    const out = applyPage(o, page.info, g.title, now);
    let host = "google.fr";
    try { host = new URL(page.url).hostname; } catch (_) { /* adresse illisible : on garde l'ancienne */ }
    if (!/(^|\.)google\.[a-z.]+$/i.test(host)) out.url = page.url;
    if (out.verified) { out.fails = 0; delete out.tried_at; } else { out.fails = (o.fails || 0) + 1; out.tried_at = now.toISOString(); }
    return out;
  });
  const { ranked } = await saveOffers(g, updated, now, { touchChecked: true });
  await planNext(g, ranked, now).catch(() => {});
}

// Relecture d'une fiche demandée par le radar (appel interne, sans code propriétaire). minAgeMs : pas deux lectures rapprochées.
export async function refreshOne(id: number, now = new Date(), opts: { minAgeMs?: number } = {}): Promise<boolean> {
  const cut = new Date(now.getTime() - (opts.minAgeMs ?? 30 * 60_000)).toISOString();
  const q = `${URL_}/rest/v1/noel_gifts?select=id,title,offers,checked_at&id=eq.${id}&or=(checked_at.is.null,checked_at.lt.${cut})&limit=1`;
  const gifts = await fetch(q, { headers: H }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(gifts) || !gifts.length) return false;
  await refreshGift(gifts[0], now);
  return true;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { cron?: boolean; code?: string; id?: number };
  try { body = await req.json(); } catch (_) { return json({ error: "requête invalide" }, 400); }
  const now = new Date();
  let gifts: Gift[] = [];

  if (body.cron === true) {
    // Hébergement VPS : le mode planning exige l'en-tête x-cron-secret (variable CRON_SECRET).
    // Sans CRON_SECRET (ancien déploiement Supabase), le comportement d'origine est conservé.
    const secret = Deno.env.get("CRON_SECRET");
    if (secret && !sameSecret(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "non autorisé" }, 403);
    // Les fiches dont l'échéance est passée (ou jamais planifiées) d'abord. Uniquement la table noel_gifts, aucune lecture des réservations.
    const q = `${URL_}/rest/v1/noel_gifts?select=id,title,offers,checked_at&or=(next_check_at.is.null,next_check_at.lte.${now.toISOString()})&order=next_check_at.asc.nullsfirst,id.asc&limit=${CRON_BATCH}`;
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
  for (const g of gifts) { try { await refreshGift(g, now, body.cron !== true); } catch (_) { /* une fiche en échec ne bloque pas les autres */ } }
  return json({ ok: true, n: gifts.length });
}

if (import.meta.main) Deno.serve(handler);
