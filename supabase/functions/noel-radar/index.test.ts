// deno test --allow-env --allow-read supabase/functions/noel-radar/index.test.ts
// Collecteur du radar : `fetch` simulé (flux Dealabs + PostgREST en mémoire). Aucune requête réelle, jamais dealabs.com.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runDealabs, isFast, _resetForTests } from "./index.ts";

Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "cle-de-test");
const FIXTURE = Deno.readTextFileSync(new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url));
const T0 = new Date("2026-11-26T09:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

// --- PostgREST en mémoire --------------------------------------------------------------------------------------------
function makeEnv() {
  const st = {
    sources: new Map<string, any>(), seen: new Set<string>(), signals: [] as any[], prices: [] as any[], nextId: 1, dealabs: [] as string[], touchedTables: new Set<string>(),
    gifts: [
      { id: 1, title: "Alimentation Cooler Master MWE Gold 850W V3", mpn: "MPX-8503-AFAG-2EBEU", offers: [{ store: "LDLC", price: 120, url: "https://www.ldlc.com/a", verified: true }], price: 120, aliases: [] },
      { id: 2, title: "Montre Garmin vivoactive 5", offers: [{ store: "Fnac", price: 250, url: "https://www.fnac.com/a" }], price: 250, aliases: [] },
      { id: 3, title: "Ecovacs Deebot T50 Omni Gen 2", offers: [{ store: "Boulanger", price: 249, url: "https://www.boulanger.com/a" }], price: 249, aliases: [] },
      { id: 4, title: "Voiture RC Mario Kart Mario Carrera", offers: [], price: null, aliases: [] },
      { id: 5, title: "Enceinte JBL Flip 6", offers: [], price: null, aliases: [] },
    ] as any[],
    script: [] as ((req: Request) => Response)[],   // réponses successives pour Dealabs
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  async function db(req: Request, u: URL): Promise<Response> {
    const table = u.pathname.replace("/rest/v1/", "");
    st.touchedTables.add(table);
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    const eq = (k: string) => u.searchParams.get(k)?.replace(/^eq\./, "");
    if (table === "noel_sources") {
      if (req.method === "GET") { const r = st.sources.get(eq("name")!); return json(r ? [r] : []); }
      for (const row of body) st.sources.set(row.name, { ...(st.sources.get(row.name) ?? {}), ...row });
      return new Response(null, { status: 201 });
    }
    if (table === "noel_feed_seen") {
      if (req.method === "GET") { const l = [...u.searchParams.get("guid")!.matchAll(/"([^"]*)"/g)].map((m) => m[1]); return json(l.filter((g) => st.seen.has(g)).map((guid) => ({ guid }))); }
      for (const row of body) st.seen.add(row.guid);
      return new Response(null, { status: 201 });
    }
    if (table === "noel_gifts") {
      if (req.method === "GET") return json(st.gifts);
      Object.assign(st.gifts.find((g) => g.id === Number(eq("id")))!, body);
      return new Response(null, { status: 204 });
    }
    if (table === "noel_signals") {
      if (req.method === "GET") return json(st.signals.filter((s) => s.status === eq("status")));
      if (req.method === "PATCH") { Object.assign(st.signals.find((s) => s.id === Number(eq("id")))!, body); return new Response(null, { status: 204 }); }
      const out = [];
      for (const row of body) {
        if (st.signals.some((s) => s.source === row.source && s.ext_id === row.ext_id && s.gift_id === row.gift_id)) continue;
        const s = { id: st.nextId++, verified: false, ...row }; st.signals.push(s); out.push(s);
      }
      return json(out, 201);
    }
    if (table === "noel_blocked") return json([]);
    if (table === "noel_prices") {
      if (req.method === "GET") return json(st.prices.filter((p) => p.gift_id === Number(eq("gift_id"))).slice(-1));
      st.prices.push(body); return new Response(null, { status: 201 });
    }
    return new Response("table inconnue : " + table, { status: 500 });   // ex. noel_claims : le radar n'y touche jamais
  }
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname === "db.test") return db(req, u);
    if (u.hostname === "www.dealabs.com") {
      st.dealabs.push(`${u.pathname}|${req.headers.get("user-agent")}|${req.headers.get("if-none-match") ?? ""}`);
      const next = st.script.shift();
      if (!next) throw new Error("réponse Dealabs non prévue : " + u.pathname);
      return next(req);
    }
    throw new Error("requête réseau inattendue : " + req.url);
  }) as typeof fetch;
  return { st, restore: () => { globalThis.fetch = real; _resetForTests(); } };
}
const rss = (xml: string, etag = "") => () => new Response(xml, { status: 200, headers: { "Content-Type": "application/rss+xml", ...(etag ? { ETag: etag } : {}) } });
const newGuids = (xml: string) => xml.replaceAll("exemple-", "autre-");
// Lecture de page simulée : Cooler Master confirmé à 89,99 € ; Ecovacs confirmé à 229 €
const read = async (url: string) => {
  const info = url.includes("cooler") ? { price: 89.99, stock: "in", name: "Alimentation Cooler Master MWE Gold 850 V3" } : { price: 229, stock: "in", name: "Robot Ecovacs Deebot T50 Omni Gen 2" };
  return { url, status: 200, info } as any;
};
const T = { sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: "radar : premier passage, pistes, vérification et fusion", ...T, async fn() {
  const { st, restore } = makeEnv();
  try {
    st.script.push(rss(FIXTURE, '"abc"'));
    const reads: string[] = [];
    const r = await runDealabs(T0, { read: (u: string) => { reads.push(u); return read(u); } });
    assertEquals([r.status, r.items, r.fresh, r.gap], ["ok", 30, 30, false]);
    assert(st.dealabs[0].startsWith("/rss/tous|NoelFamille/1.0"), "en-tête honnête");
    assertEquals(st.seen.size, 30);

    const by = (id: number) => st.signals.filter((s) => s.gift_id === id);
    assertEquals(by(1).map((s) => [s.match, s.status]), [["exact", "accepted"]], "Cooler Master : exact par MPN");
    assertEquals(by(2).map((s) => [s.match, s.status, s.verified]), [["strict", "accepted", false]], "Garmin : piste Amazon non vérifiée");
    assertEquals(by(3).map((s) => [s.match, s.status]), [["strict", "accepted"]]);
    assert(by(3)[0].conditions.some((c: any) => c.type === "code" && c.code === "10DES129"));
    assertEquals(by(4).map((s) => [s.match, s.status]), [["loose", "candidate"]], "piste approximative : à confirmer");
    assertEquals(by(5).length, 0, "cadeau sans rapport : aucune piste");
    for (const s of st.signals) { assertEquals(s.source, "dealabs"); assert(s.url === null || s.url.startsWith("https://")); assert(!JSON.stringify(s).includes("awc=")); }

    // Vérification : Amazon n'est jamais lu ; Cooler Master confirmé ; Ecovacs confirmé mais conditionnel
    assert(!reads.some((u) => u.includes("amazon")));
    assertEquals(reads.length, 2);
    assertEquals(by(1)[0].verified, true);
    assertEquals(by(3)[0].verified, true);

    // Fusion : seulement le prix confirmé et sans condition
    const g1 = st.gifts[0];
    const cd = g1.offers.find((o: any) => o.store === "Cdiscount");
    assertEquals([cd.price, cd.verified, cd.via], [89.99, true, "dealabs"]);
    assertEquals([g1.price, g1.store], [89.99, "Cdiscount"]);
    assertEquals(st.prices.at(-1).price, 89.99);
    assertEquals(st.gifts[2].offers.length, 1, "prix avec code promo : jamais fusionné");
    assertEquals(st.gifts[1].offers.length, 1, "Amazon illisible : jamais fusionné");
    assert(!st.touchedTables.has("noel_claims"), "aucun accès aux réservations");

    const src = st.sources.get("dealabs:tous");
    assertEquals([src.items_last, src.etag, src.last_error], [30, '"abc"', null]);
  } finally { restore(); }
} });

Deno.test({ name: "radar : deuxième passage sans doublon, 304, trou", ...T, async fn() {
  const { st, restore } = makeEnv();
  try {
    st.script.push(rss(FIXTURE, '"abc"'));
    await runDealabs(T0, { read });
    const n = st.signals.length;

    // Même flux avec If-None-Match : 304
    st.script.push((req) => { assertEquals(req.headers.get("if-none-match"), '"abc"'); return new Response(null, { status: 304 }); });
    assertEquals((await runDealabs(min(2), { read })).status, "not-modified");
    // Même contenu en 200 : rien de nouveau, aucun doublon
    st.script.push(rss(FIXTURE));
    const r2 = await runDealabs(min(4), { read });
    assertEquals([r2.fresh, r2.gap], [0, false]);
    assertEquals(st.signals.length, n);

    // 30 nouveaux guid peu après le dernier succès : trou probable, lecture de /rss/hot, lecture rapprochée
    st.script.push(rss(newGuids(FIXTURE)));
    st.script.push(rss(newGuids(FIXTURE).replaceAll("autre-", "hot-")));
    const before = st.dealabs.length;
    const r3 = await runDealabs(min(6), { read });
    assertEquals([r3.gap, r3.fresh], [true, 30]);
    assertEquals(st.sources.get("dealabs:tous").gaps, 1);
    assert(st.dealabs.slice(before).some((l) => l.startsWith("/rss/hot")), "lecture immédiate de /rss/hot");
    assert(isFast(min(7)) && !isFast(min(40)));
    assert(st.signals.length >= n, "pas de piste en double pour un même guid");
    assert(new Set(st.signals.map((s) => `${s.ext_id}|${s.gift_id}`)).size === st.signals.length);
  } finally { restore(); }
} });

Deno.test({ name: "radar : 429, reprise différée, flux invalide, flux désactivé", ...T, async fn() {
  const { st, restore } = makeEnv();
  try {
    st.script.push(() => new Response("trop de requêtes", { status: 429 }));
    const r = await runDealabs(T0, { read });
    assertEquals(r.status, "backoff");
    let src = st.sources.get("dealabs:tous");
    assertEquals(src.last_error, "HTTP 429");
    assertEquals(Date.parse(src.backoff_until) - T0.getTime(), 4 * 60_000);

    // Pendant l'attente : aucune requête
    assertEquals((await runDealabs(min(2), { read })).status, "backoff");
    assertEquals(st.dealabs.length, 1, "aucune requête pendant le retrait");
    // Après l'attente : nouvelle tentative ; un deuxième refus double le délai (8 min)
    st.script.push(() => new Response("", { status: 403 }));
    await runDealabs(min(5), { read });
    src = st.sources.get("dealabs:tous");
    assertEquals(Date.parse(src.backoff_until) - min(5).getTime(), 8 * 60_000);
    // Reprise : succès, l'erreur disparaît
    st.script.push(rss(FIXTURE));
    assertEquals((await runDealabs(min(14), { read })).status, "ok");
    src = st.sources.get("dealabs:tous");
    assertEquals([src.last_error, src.backoff_until], [null, null]);

    // Flux illisible : erreur visible, rien d'enregistré
    st.script.push(rss("<html>maintenance</html>"));
    const bad = await runDealabs(min(20), { read });
    assertEquals(bad.status, "error");
    assertEquals(st.sources.get("dealabs:tous").last_error, "flux vide ou illisible");

    // Flux non listé dans DEALABS_FEEDS
    Deno.env.set("DEALABS_FEEDS", "hot");
    assertEquals((await runDealabs(min(30), { read })).status, "disabled");
    Deno.env.delete("DEALABS_FEEDS");
    // Flux inconnu : jamais d'adresse libre
    assertEquals((await runDealabs(min(30), { feed: "search", read })).status, "disabled");
  } finally { Deno.env.delete("DEALABS_FEEDS"); restore(); }
} });
