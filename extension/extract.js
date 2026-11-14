// Lecture de la page affichée. Cette fonction est injectée dans l'onglet (scripting.executeScript) :
// elle doit rester autonome (aucune référence à un autre fichier). Elle ne fait que LIRE la page,
// n'envoie rien et ne modifie rien. Sources, par ordre de priorité : données structurées JSON-LD,
// microdonnées, balises Open Graph, puis titre de la page.
function extractPage() {
  const out = { url: location.href, title: "", image: "", price: null, currency: "", gtin: "", siteName: "", stockOut: false, source: "" };
  const text = el => (el && (el.getAttribute("content") || el.textContent) || "").trim();
  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"],meta[name="${n}"],meta[itemprop="${n}"]`);
      const v = el && el.getAttribute("content");
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return ""; } };
  const first = v => Array.isArray(v) ? first(v[0]) : v;

  // 1) JSON-LD : tous les blocs, @graph compris
  const nodes = [];
  const walk = n => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== "object") return;
    nodes.push(n);
    if (n["@graph"]) walk(n["@graph"]);
    if (n.mainEntity) walk(n.mainEntity);
    if (n.itemListElement) walk(n.itemListElement);
    if (n.item) walk(n.item);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try { walk(JSON.parse(s.textContent)); } catch (e) { /* bloc illisible : ignoré */ }
  });
  const isType = (n, t) => [].concat(n["@type"] || []).some(x => String(x).toLowerCase() === t.toLowerCase());
  const products = nodes.filter(n => isType(n, "Product") || isType(n, "ProductGroup") || isType(n, "IndividualProduct"));
  const prod = products.find(p => p.offers || p.hasVariant) || products[0] || null;

  const offerPrice = o => {
    if (!o || typeof o !== "object") return null;
    const spec = first(o.priceSpecification);
    const p = o.price ?? o.lowPrice ?? (spec && spec.price) ?? null;
    return p == null ? null : { price: p, currency: o.priceCurrency || (spec && spec.priceCurrency) || "", avail: String(o.availability || "") };
  };
  let offer = null;
  if (prod) {
    out.source = "json-ld";
    out.title = String(prod.name || "").trim();
    const img = first(prod.image);
    out.image = typeof img === "string" ? img : (img && (img.url || img.contentUrl)) || "";
    for (const k of ["gtin13", "gtin", "gtin14", "gtin12", "gtin8", "ean", "isbn"]) {
      const v = String(prod[k] || "").replace(/\D/g, "");
      if (/^\d{8,14}$/.test(v)) { out.gtin = v; break; }
    }
    let offers = prod.offers;
    if (!offers && Array.isArray(prod.hasVariant)) offers = prod.hasVariant.map(v => v && v.offers).filter(Boolean);
    const list = [].concat(offers || []).flatMap(o => o && o.offers ? [].concat(o.offers) : [o]);
    const priced = list.map(offerPrice).filter(Boolean);
    // plusieurs variantes : on prend la moins chère de celles en stock
    const num = v => { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : Infinity; };
    priced.sort((a, b) => (/OutOfStock|SoldOut/i.test(a.avail) ? 1 : 0) - (/OutOfStock|SoldOut/i.test(b.avail) ? 1 : 0) || num(a.price) - num(b.price));
    offer = priced[0] || null;
    if (offer) { out.price = offer.price; out.currency = offer.currency; out.stockOut = /OutOfStock|SoldOut/i.test(offer.avail); }
  }

  // 2) Microdonnées et balises de prix
  if (out.price == null) {
    const el = document.querySelector('[itemprop="price"]');
    const v = el && (el.getAttribute("content") || el.textContent);
    const mp = meta("product:price:amount", "og:price:amount", "twitter:data1");
    if (v && v.trim()) { out.price = v.trim(); out.source = out.source || "microdata"; }
    else if (mp && /\d/.test(mp)) { out.price = mp; out.source = out.source || "meta"; }
    out.currency = out.currency || text(document.querySelector('[itemprop="priceCurrency"]')) || meta("product:price:currency", "og:price:currency");
  }
  if (!out.gtin) {
    const g = (text(document.querySelector('[itemprop^="gtin"]')) || meta("product:ean", "gtin13", "gtin")).replace(/\D/g, "");
    if (/^\d{8,14}$/.test(g)) out.gtin = g;
  }

  // 3) Titre, image, site
  if (!out.title) out.title = meta("og:title", "twitter:title") || text(document.querySelector("h1")) || document.title || "";
  if (!out.image) out.image = meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
  out.siteName = meta("og:site_name", "application-name");
  out.image = out.image ? abs(out.image) : "";
  out.title = out.title.replace(/\s+/g, " ").trim().slice(0, 200);
  // « Produit | Marchand » : on retire le nom du site en fin de titre quand il est connu
  if (out.siteName) {
    const esc = out.siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.title = out.title.replace(new RegExp("\\s*[|\\-–—:]\\s*" + esc + "\\s*$", "i"), "").trim();
  }
  out.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || "";
  out.price = out.price == null ? null : String(out.price);
  return out;
}
