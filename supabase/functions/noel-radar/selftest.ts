// Test quotidien (lot L) : 3 contrôles, résultat écrit dans noel_sources (name='selftest') ; un échec allume le bandeau rouge de la gestion.
// Aucun e-mail, aucune notification. Lit seulement noel_gifts (par id, sans lien avec les réservations).
import { checkCode, checkFormat } from "./selftest.js";
import { feedStats } from "./index.ts";
import { dbGet, touchSource } from "./db.ts";
import { readMerchant } from "../noel-preview/net.ts";
import { isUnreadable } from "../noel-refresh/schedule.js";

const FIXTURE = new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url);
type Opts = { read?: typeof readMerchant; xml?: string };

export async function runSelftest(now = new Date(), opts: Opts = {}): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  let checks = 0;

  // 1. Régression du code
  try { problems.push(...checkCode(opts.xml ?? await Deno.readTextFile(FIXTURE))); checks++; }
  catch (e) { problems.push("fichier de test illisible : " + String((e as Error)?.message ?? e).slice(0, 80)); }

  // 2. Format réel du flux
  const f = checkFormat(feedStats.tous);
  if (f) problems.push(f);
  checks++;

  // 3. Pages de 2 cadeaux de référence : les deux premiers cadeaux (par id) qui ont une offre sur un marchand lisible.
  // Un prix extrait d'au moins une page suffit : une seule page en panne est du bruit, toutes en panne signalent un problème.
  try {
    const gifts = await dbGet("noel_gifts?select=id,offers&order=id.asc&limit=50");
    const urls: string[] = [];
    for (const g of gifts) {
      const o = (Array.isArray(g.offers) ? g.offers : []).find((x: any) => x && /^https:\/\//.test(x.url || "") && x.price > 0 && !isUnreadable(x.url));
      if (o) urls.push(o.url);
      if (urls.length >= 2) break;
    }
    if (urls.length) {
      const read = opts.read ?? readMerchant;
      let ok = 0;
      for (const u of urls) { try { const p = await read(u); if ((p.info as any)?.price > 0) ok++; } catch (_) { /* page en panne */ } }
      if (!ok) problems.push(`lecture des pages marchandes : aucun prix extrait sur ${urls.length} page(s) de référence`);
      checks++;
    }
  } catch (e) { problems.push("lecture des cadeaux de référence impossible : " + String((e as Error)?.message ?? e).slice(0, 80)); }

  const ok = problems.length === 0;
  await touchSource("selftest", ok
    ? { last_ok: now.toISOString(), last_error: null, items_last: checks }
    : { last_error: problems.join(" ; ").slice(0, 300), last_error_at: now.toISOString(), items_last: checks });
  console.log("noel-diag " + JSON.stringify({ selftest: ok ? "ok" : "échec", problems }));
  return { ok, problems };
}
