// deno test --allow-env --allow-read supabase/functions/noel-radar/selftest.test.ts : test quotidien, base et pages simulées
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", "http://db.test"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const { runSelftest } = await import("./selftest.ts");
const { feedStats } = await import("./index.ts");
const { checkCode, checkFormat } = await import("./selftest.js");
const XML = await Deno.readTextFile(new URL("./fixtures/dealabs-tous-2026-11-25.xml", import.meta.url));
const NOW = new Date("2026-11-30T06:15:00Z");

function mockDb(gifts: unknown[]) {
  const writes: any[] = [], orig = globalThis.fetch;
  globalThis.fetch = ((u: string, o?: RequestInit) => {
    const url = String(u);
    if (url.includes("noel_gifts")) return Promise.resolve(Response.json(gifts));
    if (url.includes("noel_sources") && o?.method === "POST") { writes.push(...JSON.parse(String(o.body))); return Promise.resolve(new Response(null, { status: 201 })); }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  return { writes, restore: () => { globalThis.fetch = orig; } };
}
const gifts = [
  { id: 1, offers: [{ store: "Amazon", price: 10, url: "https://www.amazon.fr/dp/X" }] },        // illisible : ignoré
  { id: 2, offers: [{ store: "LDLC", price: 100, url: "https://www.ldlc.com/a" }] },
  { id: 3, offers: [{ store: "Cdiscount", price: 90, url: "https://www.cdiscount.com/b" }] },
  { id: 4, offers: [{ store: "Auchan", price: 80, url: "https://www.auchan.fr/c" }] },
];

Deno.test("fichier de test : aucun écart", () => assertEquals(checkCode(XML), []));
Deno.test("régression détectée si le flux de test change", () => assert(checkCode(XML.replace(/<item>[\s\S]*?<\/item>/, "")).length > 0));
Deno.test("format : tolère l'absence de lecture, refuse un flux sans marchand", () => {
  assertEquals(checkFormat(null), null);
  assertEquals(checkFormat({ items: 30, withTitleLink: 30, withMerchant: 29 }), null);
  assert(checkFormat({ items: 30, withTitleLink: 3, withMerchant: 3 }));
  assert(checkFormat({ items: 30, withTitleLink: 30, withMerchant: 0 }));
});

Deno.test("selftest : succès, 2 pages lues parmi les cadeaux lisibles", async () => {
  feedStats.tous = { items: 30, withTitleLink: 30, withMerchant: 28 };
  const db = mockDb(gifts), seen: string[] = [];
  try {
    const r = await runSelftest(NOW, { xml: XML, read: (u: string) => { seen.push(u); return Promise.resolve({ info: { price: 99 } } as any); } });
    assertEquals(r.ok, true);
    assertEquals(seen, ["https://www.ldlc.com/a", "https://www.cdiscount.com/b"]);
    assertEquals(db.writes[0].name, "selftest"); assertEquals(db.writes[0].last_error, null); assertEquals(db.writes[0].last_ok, NOW.toISOString());
  } finally { db.restore(); }
});

Deno.test("selftest : une page en panne passe, toutes en panne échouent et écrivent l'erreur", async () => {
  feedStats.tous = null;
  let db = mockDb(gifts);
  try {
    let n = 0;
    assertEquals((await runSelftest(NOW, { xml: XML, read: () => Promise.resolve(++n === 1 ? { info: null } as any : { info: { price: 5 } } as any) })).ok, true);
  } finally { db.restore(); }
  db = mockDb(gifts);
  try {
    const r = await runSelftest(NOW, { xml: XML, read: () => Promise.resolve({ info: null } as any) });
    assertEquals(r.ok, false); assert(r.problems[0].includes("aucun prix extrait"));
    assertEquals(db.writes[0].last_error_at, NOW.toISOString()); assert(db.writes[0].last_error.length <= 300); assert(!("last_ok" in db.writes[0]));
  } finally { db.restore(); }
});

Deno.test("selftest : échec si le format réel a changé", async () => {
  feedStats.tous = { items: 30, withTitleLink: 30, withMerchant: 0 };
  const db = mockDb([]);
  try { const r = await runSelftest(NOW, { xml: XML }); assertEquals(r.ok, false); assert(r.problems[0].includes("marchand")); } finally { db.restore(); feedStats.tous = null; }
});
