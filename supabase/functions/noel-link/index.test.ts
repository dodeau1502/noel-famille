// deno test --allow-env --allow-read supabase/functions/noel-link/index.test.ts
// Lecture d'un lien collé, avec repli sur la recherche Google (Gemini simulé, aucun réseau).
import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://base.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Object.defineProperty(Deno, "resolveDns", { value: (_h: string, t: string) => Promise.resolve(t === "A" ? ["151.101.1.1"] : []), configurable: true, writable: true });
const { handler } = await import("./index.ts");

const LINK = "https://www.hollisterco.com/shop/eu-fr/p/lace-trim-layering-cami-63270319-2?seq=17";
let geminiCalls = 0;
function fake(page: string, lookup: unknown, sources = true, imgType = "image/jpeg") {
  return (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.startsWith("http://base.test/")) return Promise.resolve(Response.json({ me: { id: 3 } }));
    if (u.includes("generativelanguage.googleapis.com")) {
      geminiCalls++;
      return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(lookup) }] },
        groundingMetadata: { groundingChunks: sources ? [{ web: { uri: "https://vertexaisearch.cloud.google.com/a", title: "hollisterco.com" } }] : [] } }] }));
    }
    if (u.startsWith("https://img.hollisterco.com/")) return Promise.resolve(new Response("x", { headers: { "content-type": imgType } }));
    if (u.startsWith("https://www.hollisterco.com/")) return Promise.resolve(new Response(page, { headers: { "content-type": "text/html" } }));
    return Promise.reject(new Error("réseau interdit : " + u));
  };
}
const WALL = "<html><head><title>Client Challenge</title></head><body></body></html>";
const found = { title: "Caraco superposable à bordure en dentelle", price: 19.95, image: "https://img.hollisterco.com/p.jpg", found: true };
const post = () => handler(new Request("http://x", { method: "POST", body: JSON.stringify({ token: "t", url: LINK }) }));
const real = globalThis.fetch;
async function run(f: typeof fetch) { globalThis.fetch = f; try { return await (await post()).json(); } finally { globalThis.fetch = real; } }

Deno.test("mur anti-robots, sans clé Gemini : nom deviné d'après l'adresse", async () => {
  Deno.env.delete("GEMINI_API_KEY"); geminiCalls = 0;
  const d = await run(fake(WALL, found) as typeof fetch);
  assertEquals(d.title, "Lace trim layering cami"); assertEquals(d.guessed, true); assertEquals(d.price, null); assertEquals(geminiCalls, 0);
});
Deno.test("mur anti-robots, avec clé : nom, prix et photo par la recherche Google", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  const d = await run(fake(WALL, found) as typeof fetch);
  assertEquals(d.title, found.title); assertEquals(d.price, 19.95); assertEquals(d.image, found.image); assertEquals(d.searched, true);
  assertEquals(d.guessed, undefined); assertEquals(d.store, "hollisterco.com");
});
Deno.test("réponse sans source consultée : ignorée, nom deviné", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  const d = await run(fake(WALL, found, false) as typeof fetch);
  assertEquals(d.guessed, true); assertEquals(d.price, null); assertEquals(d.image, "");
});
Deno.test("adresse d'image qui n'est pas une image : écartée", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  const d = await run(fake(WALL, found, true, "text/html") as typeof fetch);
  assertEquals(d.image, ""); assertEquals(d.price, 19.95);
});
Deno.test("page lisible et complète : lue par Gemini, sans recherche", async () => {
  Deno.env.set("GEMINI_API_KEY", "k"); geminiCalls = 0;
  const page = `<html><head><title>Caraco</title><meta property="og:image" content="https://img.hollisterco.com/a.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Caraco","image":"https://img.hollisterco.com/a.jpg","offers":{"@type":"Offer","price":"19.95","priceCurrency":"EUR"}}</script></head></html>`;
  const d = await run(fake(page, found) as typeof fetch);
  assertEquals(d.price, 19.95); assertEquals(d.searched, false); assertEquals(geminiCalls, 1);
});
Deno.test("page lisible : couleur, taille et précisions remontées ; un prix absent de la page est refusé", async () => {
  Deno.env.set("GEMINI_API_KEY", "k");
  const page = `<html><head><title>Caraco | Boutique</title><meta property="og:image" content="https://img.hollisterco.com/a.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Caraco","offers":{"@type":"Offer","price":"19.95","priceCurrency":"EUR"}}</script></head><body><h1>Caraco</h1></body></html>`;
  const d = await run(fake(page, { is_product: true, title: "Caraco en dentelle", price: 12.34, color: "Noir", size: "S", details: "Coton", image: 0 }) as typeof fetch);
  assertEquals([d.title, d.price, d.color, d.size, d.details], ["Caraco en dentelle", 19.95, "Noir", "S", "Coton"]);
  assertEquals(d.image, "https://img.hollisterco.com/a.jpg");
});
Deno.test("aucune photo : recherche d'images, la première est mise et les autres proposées", async () => {
  Deno.env.delete("GEMINI_API_KEY"); Deno.env.set("SERPAPI_KEY", "s");
  const base = fake(WALL, found);
  const d = await run(((u: string | URL | Request, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url.startsWith("https://serpapi.com/")) return Promise.resolve(Response.json({ images_results: [
      { original: "https://img.hollisterco.com/1.jpg", link: LINK }, { original: "https://img.hollisterco.com/2.jpg", link: LINK }, { original: "https://ailleurs.test/ko.jpg" }] }));
    return base(u, init);
  }) as typeof fetch);
  assertEquals(d.image, "https://img.hollisterco.com/1.jpg"); assertEquals(d.images.length, 2); assertEquals(d.photoSearched, true);
});
Deno.test("recherche d'images en panne : le reste de la fiche est rendu", async () => {
  Deno.env.set("SERPAPI_KEY", "s");
  const d = await run(fake(WALL, found) as typeof fetch);
  assertEquals(d.image, ""); assertEquals(d.images, []); assertEquals(d.title, "Lace trim layering cami");
  Deno.env.delete("SERPAPI_KEY");
});
