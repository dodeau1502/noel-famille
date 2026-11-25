// deno test --allow-env --allow-read supabase/functions/noel-radar/sweep.test.ts : balayage Google, base et recherche simulées
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", "http://db.test"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const { runSweep, mergeFound } = await import("./sweep.ts");
const NOW = new Date("2026-11-30T03:10:00Z");
const GIFTS = [1, 2, 3].map((id) => ({ id, title: "Cadeau " + id, offers: [] }));
const found = (store: string) => ({ ok: true, searches: 2, offers: [{ store, price: 50, url: "https://" + store + ".fr/p", verified: true, at: NOW.toISOString() }] });

function mockDb(cursor: number) {
  const cursorWrites: number[] = [], patches: any[] = [], orig = globalThis.fetch;
  globalThis.fetch = ((u: string, o?: RequestInit) => {
    const url = String(u), m = o?.method || "GET";
    if (url.includes("noel_sources") && m === "GET") return Promise.resolve(Response.json([{ name: "google", items_last: cursor }]));
    if (url.includes("noel_sources") && m === "POST") { const b = JSON.parse(String(o!.body))[0]; if (b.items_last !== undefined) cursorWrites.push(b.items_last); return Promise.resolve(new Response(null, { status: 201 })); }
    if (url.includes("noel_gifts") && m === "GET") { const after = Number(/id=gt\.(\d+)/.exec(url)?.[1] ?? 0); return Promise.resolve(Response.json(GIFTS.filter((g) => g.id > after))); }
    if (url.includes("noel_gifts") && m === "PATCH") { patches.push(url); return Promise.resolve(new Response(null, { status: 204 })); }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  return { cursorWrites, patches, restore: () => { globalThis.fetch = orig; } };
}

Deno.test("sans SERPAPI_KEY : rien ne s'exécute", async () => {
  Deno.env.delete("SERPAPI_KEY");
  assertEquals((await runSweep(NOW)).status, "disabled");
});

Deno.test("balayage complet : tous les cadeaux par id, curseur remis à zéro", async () => {
  Deno.env.set("SERPAPI_KEY", "k");
  const db = mockDb(0), asked: string[] = [], uses: any[] = [];
  try {
    const r = await runSweep(NOW, { discover: ((q: string, _n: Date, o: any) => { asked.push(q); uses.push(o.use); return Promise.resolve(found("m" + asked.length)); }) as any });
    assertEquals(r.status, "ok"); assertEquals(asked, ["Cadeau 1", "Cadeau 2", "Cadeau 3"]);
    assertEquals(r.gifts, 3); assertEquals(r.searches, 6); assertEquals(r.added, 3);
    assert(uses.every((u) => u.kind === "auto" && u.cap === 120));
    assertEquals(db.cursorWrites, [1, 2, 3, 0]);
    assertEquals(db.patches.length >= 3, true);
  } finally { db.restore(); }
});

Deno.test("plafond atteint : arrêt net, curseur gardé, reprise au cadeau suivant", async () => {
  Deno.env.set("SERPAPI_KEY", "k");
  let db = mockDb(0), n = 0;
  const limited = () => { n++; return Promise.resolve(n >= 2 ? { ok: false, searches: 0, reason: "Plafond mensuel automatique atteint.", offers: [] } : found("m")); };
  try {
    const r = await runSweep(NOW, { discover: limited as any });
    assertEquals(r.status, "cap"); assertEquals(r.gifts, 1); assertEquals(db.cursorWrites, [1, 1]);
  } finally { db.restore(); }
  db = mockDb(1); const asked: string[] = [];
  try {
    await runSweep(NOW, { discover: ((q: string) => { asked.push(q); return Promise.resolve(found("z")); }) as any });
    assertEquals(asked, ["Cadeau 2", "Cadeau 3"]);                 // reprend après le cadeau 1
  } finally { db.restore(); }
});

Deno.test("SERP_AUTO_CAP : plafond configurable", async () => {
  Deno.env.set("SERPAPI_KEY", "k"); Deno.env.set("SERP_AUTO_CAP", "40");
  const db = mockDb(0); let cap = -1;
  try { await runSweep(NOW, { discover: ((_q: string, _n: Date, o: any) => { cap = o.use.cap; return Promise.resolve({ ok: true, searches: 0, offers: [] }); }) as any }); assertEquals(cap, 40); }
  finally { db.restore(); Deno.env.delete("SERP_AUTO_CAP"); }
});

Deno.test("fusion prudente : ajoute les nouveaux marchands, ne touche pas une saisie manuelle", () => {
  const old = [{ store: "LDLC", price: 100, url: "https://ldlc.fr", verified: false, via: "google" }, { store: "Darty", price: 90, url: "https://darty.fr", via: "manual", verified: false }];
  const f = [{ store: "LDLC", price: 95, url: "https://ldlc.fr", verified: true, at: "2026-11-30T00:00:00Z" }, { store: "Darty", price: 70, url: "https://darty.fr", verified: true, at: "2026-11-30T00:00:00Z" },
    { store: "Auchan", price: 80, url: "https://auchan.fr", verified: false }, { store: "Mauvais", price: 10, url: "http://x.fr" }];
  const { offers, added } = mergeFound(old, f);
  assertEquals(added, 1); assertEquals(offers.length, 3);
  assertEquals(offers[0].price, 95); assertEquals(offers[1].price, 90); assertEquals(offers[2].store, "Auchan");
});

Deno.test("compteur : auto bloqué au plafond, manuel compté sans jamais bloquer", async () => {
  Deno.env.set("SERPAPI_KEY", "k");
  const { discover } = await import("../noel-preview/discover.ts");
  const calls: string[] = [], orig = globalThis.fetch;
  let bumpOk = false;
  globalThis.fetch = ((u: string, o?: RequestInit) => {
    const url = String(u); calls.push(url.includes("serpapi.com") ? "serp" : url.includes("serp_bump") ? "bump:" + JSON.parse(String(o!.body)).p_kind + ":" + JSON.parse(String(o!.body)).p_cap : "autre");
    if (url.includes("serp_bump")) return Promise.resolve(Response.json(bumpOk ? { ok: true, n: 1 } : { ok: false, error: "cap" }));
    if (url.includes("serpapi.com")) return Promise.resolve(Response.json({ shopping_results: [] }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  try {
    const a = await discover("casque test", NOW, { use: { kind: "auto", cap: 120 } });
    assert(String(a.reason).includes("Plafond")); assert(!calls.includes("serp"));       // aucune recherche au plafond
    assertEquals(calls[0], "bump:auto:120");
    calls.length = 0;
    await discover("casque test", NOW);                                                    // manuel par défaut : compteur refusé, la recherche part quand même
    assertEquals(calls[0], "bump:manual:null"); assert(calls.includes("serp"));
  } finally { globalThis.fetch = orig; Deno.env.delete("SERPAPI_KEY"); }
});
