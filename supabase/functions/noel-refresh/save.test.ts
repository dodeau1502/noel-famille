// Relevé par marchand dans saveOffers (lot O) : fetch et base simulés
import { assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", "http://db.test"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const { saveOffers } = await import("./save.ts");

const NOW = new Date("2026-11-30T12:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

Deno.test("relevés : écrit seulement ce qui change, marque prix anormal et baisse après hausse", async () => {
  const posts: any[] = [], patches: any[] = [];
  const obs = [
    ...[[100, 4], [100, 3], [130, 1], [105, 0.5]].map(([total, d]) => ({ mkey: "ldlc", total, verified: true, stock: "in", at: day(d as number) })),
    ...[200, 210, 220].map((total, i) => ({ mkey: "m" + i, total, verified: true, stock: "in", at: day(i + 1) })),
  ];
  const orig = globalThis.fetch;
  globalThis.fetch = ((u: string, o?: RequestInit) => {
    const url = String(u), m = o?.method || "GET";
    if (url.includes("noel_observations") && m === "GET") return Promise.resolve(Response.json(obs));
    if (url.includes("noel_observations") && m === "POST") { posts.push(...JSON.parse(String(o!.body))); return Promise.resolve(new Response(null, { status: 201 })); }
    if (url.includes("noel_gifts") && m === "PATCH") { patches.push(JSON.parse(String(o!.body))); return Promise.resolve(new Response(null, { status: 204 })); }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  try {
    const O = (store: string, price: number, extra = {}) => ({ store, price, url: "https://x.fr/" + store, shipping: 0, verified: true, stock: "in", at: NOW.toISOString(), ...extra });
    // LDLC : même total que le dernier relevé de moins de 20 h => rien écrit ; Cheap : 40 € face à ~210 => anormal ; Nouveau : premier relevé
    const { ranked } = await saveOffers({ id: 7 }, [O("LDLC", 105), O("Cheap", 40), O("Nouveau", 150)], NOW);
    assertEquals(posts.map((p) => p.mkey).sort(), ["cheap", "nouveau"]);
    assertEquals(posts.every((p) => p.gift_id === 7 && p.method === "page"), true);
    const by = Object.fromEntries(ranked.map((o: any) => [o.store, o]));
    assertEquals(!!by.Cheap.anom, true); assertEquals(!!by.Nouveau.anom, false);
    assertEquals(by.LDLC.rise, day(3));                       // 105 < 130 mais >= 100 (plus bas avant hausse)
    assertEquals(patches.length > 0, true);
  } finally { globalThis.fetch = orig; }
});
