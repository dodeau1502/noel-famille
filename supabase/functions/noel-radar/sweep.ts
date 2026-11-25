// Balayage Google Shopping hebdomadaire (lot I, SerpAPI offre gratuite). Règle décidée par Dorian le 25/11/2026 :
// un seul balayage automatique par semaine, plafonné à SERP_AUTO_CAP recherches par mois (défaut 120, compteur noel_serp_usage),
// le reste du quota gratuit de 250 étant réservé aux actions manuelles. Sans SERPAPI_KEY, rien ne s'exécute.
// Tous les cadeaux, par id croissant, sans exception ni priorité (confidentialité, règle 1) ; le curseur est dans noel_sources « google ».
import { discover } from "../noel-preview/discover.ts";
import { keyOf } from "../noel-preview/trust.js";
import { saveOffers } from "../noel-refresh/save.ts";
import { dbGet, getSource, touchSource } from "./db.ts";

const diag = (o: Record<string, unknown>) => console.log("noel-diag " + JSON.stringify({ radar: "google", ...o }));
type Opts = { discover?: typeof discover; cap?: number };
export type SweepResult = { status: "ok" | "cap" | "disabled" | "error"; gifts: number; searches: number; added: number };

// Fusion prudente : un marchand absent est ajouté ; un marchand connu n'est remplacé que par une lecture vérifiée plus fraîche
export function mergeFound(old: any[], found: any[]): { offers: any[]; added: number } {
  const offers = (Array.isArray(old) ? old : []).map((o) => ({ ...o }));
  let added = 0;
  for (const f of Array.isArray(found) ? found : []) {
    if (!f || !(f.price > 0) || !/^https:\/\//.test(f.url || "")) continue;
    const i = offers.findIndex((o) => keyOf(o.store) === keyOf(f.store));
    if (i < 0) { offers.push({ ...f, via: f.via || "google" }); added++; }
    else if (f.verified && (!offers[i].verified || Date.parse(f.at || "") > Date.parse(offers[i].at || "")) && offers[i].via !== "manual") offers[i] = { ...offers[i], ...f, trust: f.trust ?? offers[i].trust };
  }
  return { offers, added };
}

export async function runSweep(now = new Date(), opts: Opts = {}): Promise<SweepResult> {
  const res: SweepResult = { status: "ok", gifts: 0, searches: 0, added: 0 };
  if (!Deno.env.get("SERPAPI_KEY")) return { ...res, status: "disabled" };
  const capEnv = Number(Deno.env.get("SERP_AUTO_CAP")), cap = opts.cap ?? (Number.isFinite(capEnv) && capEnv >= 0 ? capEnv : 120);
  const find = opts.discover ?? discover;
  try {
    let last = Number((await getSource("google")).items_last) || 0;              // curseur : dernier cadeau terminé
    for (;;) {
      const gifts = await dbGet(`noel_gifts?select=id,title,offers&id=gt.${last}&order=id.asc&limit=20`);
      if (!gifts.length) {
        await touchSource("google", { items_last: 0, last_ok: now.toISOString(), last_error: null });   // cycle fini : la semaine suivante repart du début
        break;
      }
      for (const g of gifts) {
        const d: any = await find(String(g.title), now, { use: { kind: "auto", cap } });
        res.searches += Number(d.searches) || 0;
        if (/Plafond|Limite|refus|pas encore activée/.test(String(d.reason ?? ""))) {
          res.status = /Plafond/.test(String(d.reason)) ? "cap" : "error";
          diag({ event: "arrêt", gift: g.id, why: d.reason });
          await touchSource("google", { items_last: last, last_ok: now.toISOString(), ...(res.status === "error" ? { last_error: String(d.reason).slice(0, 300), last_error_at: now.toISOString() } : { last_error: null }) });
          return res;
        }
        const m = mergeFound(g.offers, d.offers);
        if (m.added || (d.offers || []).length) await saveOffers(g, m.offers, now);
        res.gifts++; res.added += m.added; last = g.id;
        diag({ event: "fiche", gift: g.id, searches: d.searches, found: (d.offers || []).length, added: m.added });
        await touchSource("google", { items_last: last, last_ok: now.toISOString(), last_error: null });
      }
    }
  } catch (e) {
    diag({ event: "échec", why: String((e as Error)?.message ?? e).slice(0, 200) });
    await touchSource("google", { last_error: String((e as Error)?.message ?? e).slice(0, 300), last_error_at: now.toISOString() }).catch(() => {});
    return { ...res, status: "error" };
  }
  return res;
}
