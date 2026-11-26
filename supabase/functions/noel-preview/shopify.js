// Boutiques Shopify : interface officielle pour les programmes (UCP, /api/ucp/mcp), annoncée par leur /agents.md.
// Lecture du catalogue seulement : jamais de panier ni de commande. Module pur (les requêtes sont dans net.ts).

// Lien de fiche produit -> { origin, handle, variant } ; null si le lien n'a pas la forme d'une fiche Shopify.
// Formes : /products/x, /fr-fr/products/x, /collections/c/products/x, /products/x/couleur ; ?variant=ID
export function productRef(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const m = u.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([a-z0-9][a-z0-9_-]*)(?:\/[^/]*)?\/?$/i);
  if (u.protocol !== "https:" || !m) return null;
  const v = u.searchParams.get("variant") || "";
  return { origin: u.origin, handle: m[1].toLowerCase(), variant: /^\d+$/.test(v) ? v : "" };
}

// Requête JSON-RPC : la variante désignée par le lien, sinon une recherche sur les mots du nom de la fiche
export function catalogRequest(ref, profile) {
  const context = { address_country: "FR", language: "fr", currency: "EUR" };
  const [name, catalog] = ref.variant
    ? ["lookup_catalog", { ids: [`gid://shopify/ProductVariant/${ref.variant}`], context }]
    : ["search_catalog", { query: ref.handle.replace(/[-_]+/g, " "), context, pagination: { limit: 10 } }];
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { meta: { "ucp-agent": { profile } }, catalog } } };
}

const euros = (p) => (p && p.currency === "EUR" && Number.isInteger(p.amount) && p.amount > 0 ? p.amount / 100 : null);
const stockOf = (v) => (v.availability?.available === false ? "out" : v.availability?.available === true ? "in" : "");

// Réponse -> même forme que extract() (parse.js), ou null si le produit du lien n'y est pas ou n'a pas de prix en euros.
// La recherche ne renvoie qu'une partie des déclinaisons : un prix n'est « sans ambiguïté » que si le produit n'en a qu'un.
export function infoFromCatalog(rpc, ref) {
  let data = rpc?.result?.structuredContent;
  if (!data) try { data = JSON.parse(rpc?.result?.content?.[0]?.text ?? ""); } catch (_) { return null; }
  const product = (data?.products || []).find((p) => String(p?.handle || "").toLowerCase() === ref.handle);
  if (!product) return null;
  const all = Array.isArray(product.variants) ? product.variants : [];
  let chosen = null;
  if (ref.variant) {
    chosen = all.find((v) => String(v.id).endsWith("/" + ref.variant));
    if (!chosen) return null;
  }
  const variants = (chosen ? [chosen] : all).map((v) => ({ price: euros(v.price), stock: stockOf(v) })).filter((v) => v.price);
  const min = chosen ? euros(chosen.price) : euros(product.price_range?.min);
  const max = chosen ? min : euros(product.price_range?.max);
  if (!min) return null;
  const single = min === max;
  const stock = chosen ? stockOf(chosen) : variants.some((v) => v.stock === "in") ? "in" : single ? stockOf(all[0] || {}) : "";
  const title = String(product.title || "");
  const image = String(product.media?.find((m) => /^https:\/\//.test(m?.url || ""))?.url || "");
  return {
    title: title.slice(0, 120), heading: title.slice(0, 160), name: title.slice(0, 160), image, price: min,
    store: new URL(ref.origin).hostname.replace(/^www\./, ""), gtin: "", stock, prices: single ? 1 : 2, variants, catalog: true,
  };
}
