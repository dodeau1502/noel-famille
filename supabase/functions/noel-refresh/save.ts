// Enregistrement des offres d'une fiche : tri, meilleur prix, historique. Partagé par la relecture (noel-refresh) et le radar (noel-radar).
// Confidentialité : ne touche que noel_gifts et noel_prices, jamais aux réservations ; traite toutes les fiches de la même façon.
import { totalOf } from "./offers.js";
import { bestOffer, rank } from "./verify.js";
import { anomaly, methodOf, mkeyOf, riseBeforeDrop, shouldRecord } from "../noel-radar/observe.js";

function cfg() {
  const url = Deno.env.get("SUPABASE_URL")!, srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { url, h: { apikey: srv, Authorization: `Bearer ${srv}`, "Content-Type": "application/json" } };
}

// touchChecked : met à jour checked_at (relecture des pages). Le radar ne le touche pas.
export async function saveOffers(g: { id: number }, offers: any[], now: Date, opts: { touchChecked?: boolean } = {}) {
  const { url, h } = cfg();
  offers = await observe(g, offers, now).catch(() => offers);   // un échec du relevé ne bloque jamais l'enregistrement des offres
  const ranked = rank(offers);
  const best = bestOffer(ranked);
  const patch: Record<string, unknown> = {};
  if (opts.touchChecked) patch.checked_at = now.toISOString();
  if (ranked.length) {
    patch.offers = ranked; patch.offers_at = now.toISOString();
    if (best) { patch.price = best.price; patch.store = best.store; }
  }
  if (Object.keys(patch).length) await fetch(`${url}/rest/v1/noel_gifts?id=eq.${g.id}`, { method: "PATCH", headers: h, body: JSON.stringify(patch) });

  // Historique : un point par jour au plus (ou dès que le meilleur prix change)
  if (best) {
    const total = totalOf(best);
    const last = await fetch(`${url}/rest/v1/noel_prices?gift_id=eq.${g.id}&order=at.desc&limit=1&select=price,at`, { headers: h }).then((r) => r.json()).catch(() => []);
    const l = Array.isArray(last) ? last[0] : null;
    const sameDay = l && now.getTime() - new Date(l.at).getTime() < 20 * 3600_000;
    if (!l || Number(l.price) !== total || !sameDay) {
      await fetch(`${url}/rest/v1/noel_prices`, {
        method: "POST", headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({ gift_id: g.id, price: total, store: best.store, verified: !!best.verified, at: now.toISOString() }),
      });
    }
  }
  return { ranked, best };
}

// Relevé par marchand (lot O) : une ligne par offre quand le total, le stock ou l'état vérifié change (ou au bout de 20 h).
// Puis, d'après les relevés de 30 jours : prix anormal (< 0,5 × médiane des autres marchands) => o.anom ; baisse après hausse => o.rise.
// Traite toutes les fiches de la même façon, sans lecture des réservations.
async function observe(g: { id: number }, offers: any[], now: Date): Promise<any[]> {
  const { url, h } = cfg();
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const get = () => fetch(`${url}/rest/v1/noel_observations?gift_id=eq.${g.id}&at=gte.${since}&select=mkey,total,verified,stock,at&order=at.asc&limit=2000`, { headers: h })
    .then((r) => r.json()).then((a) => (Array.isArray(a) ? a : []));
  const obs: any[] = await get();
  const fresh: any[] = [];
  for (const o of offers) {
    if (!o || !(o.price > 0)) continue;
    const mkey = mkeyOf(o.store); if (!mkey) continue;
    const next = { total: totalOf(o), stock: o.stock || "", verified: !!o.verified };
    const last = [...obs].reverse().find((x) => x.mkey === mkey);
    if (!shouldRecord(last, next, now)) continue;
    const row = { gift_id: g.id, mkey, merchant: String(o.store || "").slice(0, 80), price: o.price, shipping: typeof o.shipping === "number" ? o.shipping : null,
      total: next.total, stock: next.stock, verified: next.verified, method: methodOf(o), at: now.toISOString() };
    fresh.push(row); obs.push({ mkey, total: next.total, verified: next.verified, stock: next.stock, at: row.at });
  }
  if (fresh.length) await fetch(`${url}/rest/v1/noel_observations`, { method: "POST", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify(fresh) });
  return offers.map((o) => {
    if (!o || !o.verified || !(o.price > 0)) return o;
    const mkey = mkeyOf(o.store), out = { ...o };
    const rise = riseBeforeDrop(obs, mkey, now);
    if (rise) out.rise = rise.at; else delete out.rise;
    // Prix anormal : drapeau « anom » (la page le traite comme « Prudence » : jamais « Le moins cher »), retiré dès que le prix redevient normal
    if (anomaly(obs.filter((x) => x.mkey !== mkey), totalOf(o), now)) out.anom = true; else delete out.anom;
    return out;
  });
}
