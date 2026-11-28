// Lecture d'une capture d'écran par Gemini (API generateContent). Partie pure : construction des requêtes et lecture des réponses.
// Testée par gemini.test.mjs, sans clé ni réseau. Les appels eux-mêmes sont dans index.ts.

export const API = "https://generativelanguage.googleapis.com/v1beta/models/";

const PROMPT = `Voici une capture d'écran d'un produit qu'une personne veut ajouter à sa liste de Noël (page d'un magasin, application, publication…).
Lis-la et remplis les champs. Règles :
- title : nom du produit tel qu'il est affiché, marque comprise si elle est visible, sans le nom du magasin. 120 caractères au plus.
- price : prix actuel à payer par un client ordinaire, en euros, en nombre (ex. 19.95). Jamais un prix barré, un prix « membre », « avec abonnement »,
  « dès », une mensualité ou le prix d'un autre article de la capture. null si tu n'es pas sûr ou si le prix n'est pas en euros.
- color, size : seulement si une option est clairement sélectionnée ou écrite (ex. « Bleu marine », « M », « 42 »). Sinon chaîne vide.
- details : autre précision utile visible (modèle, contenance, version), courte. Sinon chaîne vide.
- store : nom du magasin ou du site s'il est visible (logo, barre d'adresse, texte). Sinon chaîne vide.
- url : adresse complète si elle est lisible en entier dans la barre d'adresse. Sinon chaîne vide. N'invente jamais d'adresse.
- box : cadre de la photo principale du produit, [ymin, xmin, ymax, xmax] en entiers de 0 à 1000. null s'il n'y a pas de photo du produit.
- search : requête Google courte pour retrouver la page de ce produit (nom exact, marque, magasin).
- is_product : false si la capture ne montre aucun produit.
Ne devine rien qui n'est pas visible sur la capture.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" }, price: { type: "NUMBER", nullable: true }, color: { type: "STRING" }, size: { type: "STRING" },
    details: { type: "STRING" }, store: { type: "STRING" }, url: { type: "STRING" },
    box: { type: "ARRAY", items: { type: "INTEGER" }, nullable: true }, search: { type: "STRING" }, is_product: { type: "BOOLEAN" },
  },
  required: ["title", "price", "color", "size", "details", "store", "url", "box", "search", "is_product"],
};

export function extractRequest(b64, mime = "image/jpeg") {
  return {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
  };
}

// Texte renvoyé par Gemini (toutes les parties « text » du premier candidat)
export function textOf(res) {
  const parts = res?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => (typeof p?.text === "string" && !p.thought ? p.text : "")).join("") : "";
}

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const httpsUrl = (u) => {
  try { const x = new URL(String(u).trim()); return x.protocol === "https:" && x.hostname.includes(".") ? x.href : ""; } catch (_) { return ""; }
};

// Réponse de la lecture → champs propres (tout ce qui est douteux est vidé)
export function parseExtract(res) {
  let o = null;
  const t = textOf(res).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try { o = JSON.parse(t); } catch (_) { return null; }
  if (!o || typeof o !== "object") return null;
  const price = typeof o.price === "number" && isFinite(o.price) && o.price > 0 && o.price < 100000 ? Math.round(o.price * 100) / 100 : null;
  let box = null;
  if (Array.isArray(o.box) && o.box.length === 4 && o.box.every((n) => typeof n === "number" && n >= 0 && n <= 1000)) {
    const [y0, x0, y1, x1] = o.box;
    if (y1 - y0 >= 30 && x1 - x0 >= 30) box = [y0, x0, y1, x1].map(Math.round);
  }
  return {
    product: o.is_product !== false, title: str(o.title, 120), price, color: str(o.color, 80), size: str(o.size, 80),
    details: str(o.details, 300), store: str(o.store, 80), url: httpsUrl(o.url).slice(0, 2000), box, search: str(o.search, 200),
  };
}

// Recherche Google (outil google_search) pour retrouver la page du produit
export function searchRequest(info) {
  const where = info.store ? ` sur le site du magasin « ${info.store} »` : "";
  return {
    contents: [{ role: "user", parts: [{ text:
      `Fais une recherche Google (obligatoire, ne réponds jamais de mémoire) pour trouver la page qui vend ce produit${where} : « ${info.search || info.title} ».\n` +
      `Réponds avec l'adresse de la page du produit (une ligne commençant par https://), ou par le mot aucune. ` +
      `Pas de comparateur de prix, pas de réseau social, pas de page de recherche.` }] }],
    tools: [{ google_search: {} }],
  };
}

// Sites qui ne sont pas la page d'un magasin
const NOT_SHOP = /(^|\.)(google\.[a-z.]+|vertexaisearch\.cloud\.google\.com|idealo\.[a-z.]+|ledenicheur\.fr|kelkoo\.[a-z.]+|dealabs\.com|pinterest\.[a-z.]+|youtube\.com|facebook\.com|instagram\.com|tiktok\.com|reddit\.com|wikipedia\.org)$/i;
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch (_) { return ""; } };

// Adresses citées : celles du texte, et les sources (liens de redirection Google, à résoudre ensuite) avec leur titre (nom du site)
export function searchSources(res) {
  const text = textOf(res);
  const inText = [...new Set((text.match(/https:\/\/[^\s<>"')\]]+/g) || []).map((u) => httpsUrl(u.replace(/[.,;:!?]+$/, ""))).filter(Boolean))];
  const chunks = (res?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map((c) => ({ uri: httpsUrl(c?.web?.uri || ""), title: str(c?.web?.title, 100).toLowerCase() })).filter((c) => c.uri);
  return { inText, chunks };
}

const letters = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

// Choix du lien : une adresse du texte n'est gardée que si son site fait partie des sources réellement consultées par la recherche
// (pas d'adresse inventée). Préférence au site du magasin vu sur la capture, puis à une page qui a l'air d'une fiche produit.
// resolved : sources résolues [{url, title}] (url = adresse finale après la redirection Google).
export function pickLink(inText, resolved, store) {
  const ok = (u) => u && !NOT_SHOP.test(hostOf(u)) && new URL(u).pathname.length > 1;
  const sourceHosts = new Set(resolved.map((r) => hostOf(r.url)).concat(resolved.map((r) => r.title.replace(/^www\./, ""))));
  const cands = [
    ...inText.filter((u) => ok(u) && sourceHosts.has(hostOf(u))),
    ...resolved.map((r) => r.url).filter(ok),
  ];
  if (!cands.length) return "";
  const s = letters(store);
  const score = (u) => (s && letters(hostOf(u)).includes(s.slice(0, 8)) ? 2 : 0) + (new URL(u).pathname.split("/").filter(Boolean).length >= 2 ? 1 : 0);
  return cands.map((u, i) => ({ u, k: score(u) * 100 - i })).sort((a, b) => b.k - a.k)[0].u;
}

// Lien collé illisible ou incomplet : recherche Google du produit de cette adresse (nom, prix, photo).
// Pas d'outil de lecture de la page par Google (refusé : ce serait faire lire par un autre un site qui nous bloque).
export function lookupRequest(url, guess) {
  return {
    contents: [{ role: "user", parts: [{ text:
      `Fais une recherche Google (obligatoire, ne réponds jamais de mémoire) sur le produit vendu à cette adresse : ${url}\n` + (guess ? `Nom probable : « ${guess} ».\n` : "") +
      `Réponds UNIQUEMENT par un objet JSON, sans texte autour, avec ces clés :\n` +
      `"title" : nom exact du produit, marque comprise, sans le nom du magasin ;\n` +
      `"price" : prix actuel en euros pour un client ordinaire chez CE magasin (nombre ; null si tu ne le trouves pas dans les résultats ; jamais un prix barré ou réservé aux membres) ;\n` +
      `"image" : adresse https directe d'une photo de ce produit (fichier image) si elle apparaît dans les résultats, sinon "" ;\n` +
      `"found" : true seulement si tu as trouvé CE produit précis.\n` +
      `N'invente rien : en cas de doute, null ou "".` }] }],
    tools: [{ google_search: {} }],
  };
}

// Réponse de la recherche : rien n'est gardé si la recherche n'a consulté aucune source (réponse « de mémoire ») ou si le produit n'est pas trouvé
export function parseLookup(res) {
  const sources = res?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(sources) || !sources.length) return null;
  const m = textOf(res).match(/\{[\s\S]*\}/);
  let o;
  try { o = JSON.parse(m ? m[0] : ""); } catch (_) { return null; }
  if (!o || typeof o !== "object" || o.found !== true) return null;
  const price = typeof o.price === "number" && isFinite(o.price) && o.price > 0 && o.price < 100000 ? Math.round(o.price * 100) / 100 : null;
  const image = httpsUrl(o.image);
  return { title: str(o.title, 120), price, image: image.length <= 2000 ? image : "" };
}
