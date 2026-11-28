// deno test --allow-env --allow-read supabase/functions/noel-capture/index.test.ts
// Gemini, la base et le site du magasin sont simulés (aucune clé, aucun réseau).
import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://base.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
// Contrôle des adresses internes (net.ts) : DNS simulé, adresse publique
Object.defineProperty(Deno, "resolveDns", { value: (_h: string, t: string) => Promise.resolve(t === "A" ? ["151.101.1.1"] : []), configurable: true, writable: true });
const { handler } = await import("./index.ts");

const IMG = "A".repeat(2000);
const extract = { title: "Caraco superposable à bordure en dentelle", price: 19.95, color: "Bleu marine", size: "M", details: "", store: "Hollister",
  url: "", box: [100, 50, 600, 950], search: "Hollister caraco dentelle", is_product: true };
const PRODUCT = "https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319";
const calls: string[] = [];
const sent: any[] = [];

function fakeFetch(extractOut: unknown, shopHtml: string) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    calls.push(u.split("?")[0]);
    if (u.startsWith("http://base.test/rest/v1/rpc/noel_home")) {
      const tok = JSON.parse(String(init?.body)).p_token;
      return Promise.resolve(Response.json(tok === "bon" ? { me: { id: 7 } } : {}));
    }
    if (u.includes("generativelanguage.googleapis.com")) {
      const b = JSON.parse(String(init?.body)); sent.push(b);
      if (b.tools) return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: PRODUCT }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x1", title: "hollisterco.com" } }] } }] }));
      return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(extractOut) }] } }] }));
    }
    if (u.startsWith("https://vertexaisearch.cloud.google.com/")) return Promise.resolve(new Response(null, { status: 302, headers: { location: PRODUCT } }));
    if (u.startsWith("https://www.hollisterco.com/")) return Promise.resolve(new Response(shopHtml, { status: 200, headers: { "content-type": "text/html" } }));
    return Promise.reject(new Error("réseau interdit : " + u));
  };
}
const post = (body: unknown) => handler(new Request("http://x/functions/v1/noel-capture", { method: "POST", body: JSON.stringify(body) }));
const realFetch = globalThis.fetch;

Deno.test("sans clé Gemini : coupé", async () => {
  Deno.env.delete("GEMINI_API_KEY");
  const r = await post({ token: "bon", image: IMG });
  assertEquals(r.status, 503); assertEquals((await r.json()).error, "off");
});

Deno.test("session et image vérifiées avant tout appel à Gemini", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  globalThis.fetch = fakeFetch(extract, "") as typeof fetch; calls.length = 0;
  try {
    assertEquals((await post({ token: "mauvais", image: IMG })).status, 403);
    assertEquals((await post({ token: "bon", image: "pas<du>base64" })).status, 400);
    assertEquals(calls.some((c) => c.includes("generativelanguage")), false);
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("capture lue, lien trouvé par la recherche, photo du site (mur anti-robots : pas de photo, le cadre est renvoyé)", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  // Le site renvoie son mur « Client Challenge » : aucune photo du site, la page recadrera la capture
  globalThis.fetch = fakeFetch(extract, "<html><head><title>Client Challenge</title></head></html>") as typeof fetch; sent.length = 0;
  try {
    const d = await (await post({ token: "bon", image: IMG })).json();
    assertEquals(d.title, extract.title); assertEquals(d.price, 19.95); assertEquals(d.color, "Bleu marine"); assertEquals(d.size, "M");
    assertEquals(d.url, PRODUCT); assertEquals(d.found, "search"); assertEquals(d.image, ""); assertEquals(d.box, [100, 50, 600, 950]);
    assertEquals(d.store, "hollisterco.com");
    assertEquals(sent[0].contents[0].parts[0].inline_data.data, IMG);   // l'image part bien
    assertEquals(sent.length, 2);                                       // lecture + recherche
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("adresse lisible sur la capture : pas de recherche, photo lue sur le site", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  const html = `<html><head><title>Caraco</title><meta property="og:title" content="Caraco"><meta property="og:image" content="https://img.hollisterco.com/p.jpg"></head></html>`;
  globalThis.fetch = fakeFetch({ ...extract, url: PRODUCT }, html) as typeof fetch; sent.length = 0;
  try {
    const d = await (await post({ token: "bon", image: IMG })).json();
    assertEquals(d.found, "visible"); assertEquals(d.image, "https://img.hollisterco.com/p.jpg"); assertEquals(sent.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("pas de produit sur la capture", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  globalThis.fetch = fakeFetch({ ...extract, is_product: false }, "") as typeof fetch;
  try { assertEquals((await (await post({ token: "bon", image: IMG })).json()).error, "noproduct"); }
  finally { globalThis.fetch = realFetch; }
});

Deno.test("modèle surchargé : le modèle de secours répond ; erreur de clé : pas de second essai", async () => {
  Deno.env.set("GEMINI_API_KEY", "k"); Deno.env.set("GEMINI_MODEL", "principal"); Deno.env.set("GEMINI_FALLBACK_MODEL", "secours");
  const ok = fakeFetch({ ...extract, url: PRODUCT }, "<html></html>");
  const used: string[] = [];
  let status = 503;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const m = String(input).match(/models\/([^:]+):generateContent/);
    if (m) { used.push(m[1]); if (m[1] === "principal") return Promise.resolve(new Response("", { status })); }
    return ok(input, init);
  }) as typeof fetch;
  try {
    assertEquals((await (await post({ token: "bon", image: IMG })).json()).title, extract.title);
    assertEquals(used, ["principal", "secours"]);
    used.length = 0; status = 403;
    assertEquals((await (await post({ token: "bon", image: IMG })).json()).error, "ai");
    assertEquals(used, ["principal"]);
  } finally { globalThis.fetch = realFetch; Deno.env.delete("GEMINI_MODEL"); Deno.env.delete("GEMINI_FALLBACK_MODEL"); }
});
