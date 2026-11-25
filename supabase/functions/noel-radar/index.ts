// Radar des promotions : lecture du flux RSS officiel de Dealabs, rapprochement avec les cadeaux, vérification sur la page du marchand.
// Pas de route publique : ces fonctions sont appelées par le planificateur (server/jobs.ts).
// Règles (CLAUDE.md et GUIDE-RADAR-PRIX) :
//  - seul le flux RSS est lu (jamais les pages de deals, /search, /graphql, /rest-api/, /visit/) ; en-tête honnête, aucune imitation de navigateur ;
//  - 429, 403 ou 5xx : on attend (retrait progressif), on ne contourne jamais (ni autre en-tête, ni proxy, ni miroir) ;
//  - confidentialité : les cadeaux sont lus sans jointure avec les réservations ; tous sont traités de la même façon ;
//  - une piste n'est une offre qu'une fois confirmée sur la page du marchand et sans condition (Dealabs reste un comparateur, règle 4).
import { parseFeed, factOf } from "./dealabs.js";
import { statsOf } from "./selftest.js";
import { conditionsOf, isConditional } from "./conditions.js";
import { matchAll, titleKey } from "./match.js";
import { readLimited, readMerchant } from "../noel-preview/net.ts";
import { applyPage } from "../noel-preview/verify.js";
import { isMarketplace, isComparator } from "../noel-preview/offers.js";
import { keyOf, hostOf, isBlocked } from "../noel-preview/trust.js";
import { saveOffers } from "../noel-refresh/save.ts";
import { dbGet, dbPost, dbPatch, enc, getSource, touchSource } from "./db.ts";

const UA = "NoelFamille/1.0 (+https://noel.dorianlab.fr; liste de Noel familiale, usage personnel)";
const FEED_URLS: Record<string, string> = { tous: "https://www.dealabs.com/rss/tous", hot: "https://www.dealabs.com/rss/hot" };
const DAILY_CAP = 1200;               // requêtes Dealabs par jour, tous flux confondus
const VERIFY_MAX = 4;                 // lectures de pages marchandes au plus par passage
const VERIFY_GAP_MS = 30 * 60_000;    // une lecture par cadeau et par marchand toutes les 30 min
const GAP_WINDOW_MS = 10 * 60_000, FAST_MS = 30 * 60_000;
const TOLERANCE = 0.03;
// Marchands qui ne se laissent pas lire (CLAUDE.md, limites connues) : on n'essaie pas, la piste reste « non vérifiée »
const UNREADABLE = /(^|\.)(amazon|fnac|darty|sony|lego|boulanger|decathlon|uniqlo)\./;

// État en mémoire (remis à zéro au redémarrage : acceptable, les plafonds durs restent respectés au jour près)
const fails = new Map<string, number>();
const lastVerify = new Map<string, number>();
const daily = { day: "", n: 0 };
let fastUntil = 0;
// Forme de la dernière lecture complète de chaque flux (test quotidien, lot L) ; en mémoire
export const feedStats: Record<string, ReturnType<typeof statsOf> | null> = { tous: null, hot: null };
export const isFast = (now = new Date()) => now.getTime() < fastUntil;
export function _resetForTests() { fails.clear(); lastVerify.clear(); daily.day = ""; daily.n = 0; fastUntil = 0; }

const diag = (o: Record<string, unknown>) => console.log("noel-diag " + JSON.stringify({ radar: "dealabs", ...o }));
const parisDay = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const enabledFeeds = () => (Deno.env.get("DEALABS_FEEDS") ?? "tous,hot").split(",").map((s) => s.trim()).filter(Boolean);

export type RunResult = { feed: string; status: "ok" | "not-modified" | "backoff" | "error" | "cap" | "disabled"; items?: number; fresh?: number; signals?: number; merged?: number; gap?: boolean };
type Opts = { feed?: string; read?: typeof readMerchant; verifyMax?: number };

export async function runDealabs(now = new Date(), opts: Opts = {}): Promise<RunResult> {
  const feed = opts.feed ?? "tous", name = `dealabs:${feed}`;
  if (!FEED_URLS[feed] || !enabledFeeds().includes(feed)) return { feed, status: "disabled" };
  try {
    const src = await getSource(name);
    if (src.backoff_until && Date.parse(src.backoff_until) > now.getTime()) return { feed, status: "backoff" };
    const day = parisDay(now);
    if (daily.day !== day) { daily.day = day; daily.n = 0; }
    if (daily.n >= DAILY_CAP) return { feed, status: "cap" };
    daily.n++;

    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/rss+xml" };
    if (src.etag) headers["If-None-Match"] = src.etag;
    if (src.last_modified) headers["If-Modified-Since"] = src.last_modified;
    let res: Response;
    try {
      res = await fetch(FEED_URLS[feed], { headers, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      return await failed(name, feed, now, e instanceof DOMException && e.name === "TimeoutError" ? "délai dépassé" : "réseau indisponible");
    }
    if (res.status === 304) {
      fails.delete(name);
      await touchSource(name, { last_ok: now.toISOString(), last_error: null, backoff_until: null });
      return { feed, status: "not-modified" };
    }
    if (res.status === 429 || res.status === 403 || res.status >= 500) { await res.body?.cancel().catch(() => {}); return await failed(name, feed, now, `HTTP ${res.status}`); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return await failed(name, feed, now, `HTTP ${res.status}`, false); }
    // Adresse fixe, mais on contrôle l'hôte final après d'éventuelles redirections
    try { if (!/(^|\.)dealabs\.com$/.test(new URL(res.url || FEED_URLS[feed]).hostname)) return await failed(name, feed, now, "redirection inattendue", false); } catch (_) { /* res.url vide dans un test */ }

    const { items } = parseFeed(await readLimited(res, 2_000_000));
    if (!items.length) return await failed(name, feed, now, "flux vide ou illisible", false);
    feedStats[feed] = statsOf(items);

    // Dédoublonnage : chaque guid n'est traité qu'une fois
    const guids = items.map((i) => i.guid);
    const known = new Set((await dbGet(`noel_feed_seen?select=guid&guid=in.(${guids.map((g) => enc(`"${g.replace(/"/g, "")}"`)).join(",")})`)).map((r) => r.guid));
    const fresh = items.filter((i) => !known.has(i.guid));
    // Trou probable : le dernier succès est récent et aucun élément du flux n'était déjà connu (le débit a dépassé la taille du flux)
    const gap = !!src.last_ok && now.getTime() - Date.parse(src.last_ok) < GAP_WINDOW_MS && known.size === 0;
    if (fresh.length) await dbPost("noel_feed_seen?on_conflict=guid", fresh.map((i) => ({ guid: i.guid, feed: name })), "resolution=ignore-duplicates,return=minimal");

    const out = fresh.length ? await handleFresh(fresh.map(factOf), now, opts) : { signals: 0, merged: 0 };
    const newest = items.reduce((m, i) => Math.max(m, i.pubDate.getTime()), 0);
    fails.delete(name);
    await touchSource(name, {
      last_ok: now.toISOString(), last_error: null, backoff_until: null, items_last: items.length, last_item_at: new Date(newest).toISOString(),
      etag: res.headers.get("etag"), last_modified: res.headers.get("last-modified"), gaps: (src.gaps ?? 0) + (gap ? 1 : 0),
    });
    if (gap) {
      diag({ feed, event: "trou probable", items: items.length });
      fastUntil = now.getTime() + FAST_MS;              // lecture toutes les 60 s pendant 30 min, jamais moins
      if (feed === "tous") await runDealabs(now, { ...opts, feed: "hot" });
    }
    return { feed, status: "ok", items: items.length, fresh: fresh.length, gap, ...out };
  } catch (e) {
    return await failed(name, feed, now, String((e as Error)?.message ?? e), false);
  }
}

// Échec de lecture : retrait progressif (2 min, 4 min… 60 min). withBackoff=false pour une erreur qui n'est pas un refus du serveur.
async function failed(name: string, feed: string, now: Date, why: string, withBackoff = true): Promise<RunResult> {
  const n = (fails.get(name) ?? 0) + 1;
  fails.set(name, n);
  const patch: Record<string, unknown> = { last_error: why.slice(0, 300), last_error_at: now.toISOString() };
  if (withBackoff) patch.backoff_until = new Date(now.getTime() + Math.min(2 ** n * 2, 60) * 60_000).toISOString();
  diag({ feed, event: "échec", why });
  await touchSource(name, patch).catch(() => {});
  return { feed, status: withBackoff ? "backoff" : "error" };
}

// Rapprochement, enregistrement des pistes, vérification immédiate et fusion
async function handleFresh(facts: ReturnType<typeof factOf>[], now: Date, opts: Opts) {
  // Aucune jointure avec les réservations : seulement des colonnes publiques de noel_gifts
  const gifts = await dbGet("noel_gifts?select=id,title,variant,gtin,asin,mpn,aliases,url,offers,price&order=id.asc");
  const rejected = new Set((await dbGet("noel_signals?select=gift_id,title&status=eq.rejected&limit=1000")).map((r) => `${r.gift_id}|${titleKey(r.title)}`));
  const pairs = matchAll(gifts, facts, {
    rejected,
    onSkip: (g: any, f: any, why: string) => diag({ event: "écarté", gift: g.id, deal: f.title.slice(0, 60), merchant: f.merchant, price: f.price, why }),
  });
  if (!pairs.length) return { signals: 0, merged: 0 };

  const https = (u: string | null | undefined, max = 500) => (typeof u === "string" && /^https:\/\//.test(u) && u.length <= max ? u : null);
  const rows = pairs.map((p) => {
    const f = p.fact;
    return {
      gift_id: p.gift_id, source: "dealabs", ext_id: f.guid.slice(0, 300), title: f.title.slice(0, 200), merchant: f.merchant ? f.merchant.slice(0, 80) : null,
      price: f.price > 0 && f.price < 100000 ? f.price : null, url: https(f.links[0]), page_url: https(f.page_url),
      conditions: [...conditionsOf(f.title, f.html), ...p.extra], ref30: f.ref30, match: p.level,
      status: p.level === "loose" ? "candidate" : "accepted", seen_at: f.pubDate.toISOString(),
    };
  });
  for (const r of rows) diag({ event: "retenu", gift: r.gift_id, deal: r.title.slice(0, 60), merchant: r.merchant, price: r.price, level: r.match });
  const inserted: any[] = (await dbPost("noel_signals?on_conflict=source,ext_id,gift_id", rows, "resolution=ignore-duplicates,return=representation")) ?? [];

  // Une piste acceptée demande une relecture prochaine de la fiche : le prochain passage s'en charge, dans les plafonds (lot P)
  for (const id of new Set(inserted.filter((x) => x.status === "accepted").map((x) => x.gift_id))) {
    await dbPatch(`noel_gifts?id=eq.${id}`, { next_check_at: now.toISOString() }).catch(() => {});
  }

  // Vérification immédiate sur la page du marchand
  const blockedRows = await dbGet("noel_blocked?select=key,host");
  const blocked = { keys: new Set(blockedRows.map((b) => b.key)), hosts: new Set(blockedRows.map((b) => b.host).filter(Boolean)) };
  const byId = new Map(gifts.map((g) => [g.id, g]));
  const read = opts.read ?? readMerchant;
  let reads = 0, merged = 0;
  for (const s of inserted) {
    if (s.status !== "accepted" || !s.url || !(s.price > 0) || !s.merchant) continue;
    const gift = byId.get(s.gift_id);
    if (!gift || UNREADABLE.test(hostOf(s.url))) continue;
    const k = `${s.gift_id}|${keyOf(s.merchant)}`;
    if (reads >= (opts.verifyMax ?? VERIFY_MAX) || now.getTime() - (lastVerify.get(k) ?? 0) < VERIFY_GAP_MS) continue;
    reads++; lastVerify.set(k, now.getTime());
    const offer = { store: s.merchant, price: Number(s.price), url: s.url };
    const page = await read(s.url);
    const out = applyPage(offer, page.info, gift.title, now);
    const confirmed = out.verified && Math.abs(out.price - offer.price) / offer.price <= TOLERANCE;
    const pagePrice = Number(page.info?.price ?? 0);
    const patch: Record<string, unknown> = confirmed ? { verified: true, verified_at: now.toISOString() } : pagePrice > 0 ? { page_price: pagePrice } : {};
    if (Object.keys(patch).length) await dbPatch(`noel_signals?id=eq.${s.id}`, patch).catch(() => {});
    diag({ event: "vérifié", signal: s.id, confirmed, price: offer.price, page: page.info?.price ?? null });

    // Fusion : confirmée, sans condition, marchand autorisé et en stock
    const probe = { store: s.merchant, url: s.url };
    if (!confirmed || isConditional(s.conditions) || out.stock === "out" || isMarketplace(s.merchant, s.url) || isComparator(s.merchant, s.url) || isBlocked(probe, blocked)) continue;
    const offers: any[] = Array.isArray(gift.offers) ? gift.offers.map((o: any) => ({ ...o })) : [];
    const old = offers.find((o) => keyOf(o.store) === keyOf(s.merchant));
    const merged1 = { ...(old || {}), store: old?.store || s.merchant, price: out.price, url: s.url, verified: true, stock: out.stock || "", at: now.toISOString(), via: "dealabs" };
    if (old) offers[offers.indexOf(old)] = merged1; else offers.push({ ...merged1, trust: null });
    gift.offers = offers;
    const { ranked, best } = await saveOffers(gift, offers, now);
    gift.offers = ranked; if (best) gift.price = best.price;
    merged++;
  }
  return { signals: inserted.length, merged };
}

// Keepa (lot H) et boîte d'alertes (lot J) : en attente d'exemples réels (voir le guide). Sans configuration, rien ne s'exécute.
export async function runKeepa(_now = new Date()): Promise<{ status: "disabled" }> { return { status: "disabled" }; }
export async function runMail(_now = new Date()): Promise<{ status: "disabled" }> { return { status: "disabled" }; }
