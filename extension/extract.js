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

  // 2 bis) Amazon : pas de JSON-LD ni d'Open Graph, on lit les éléments de la fiche produit
  if (/(^|\.)amazon\.[a-z.]+$/i.test(location.hostname)) {
    const q = sel => document.querySelector(sel);
    const t = el => (el && el.textContent || "").replace(/\s+/g, " ").trim();
    const asin = (q("input#ASIN") || {}).value || (location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1] || "";
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) out.url = location.origin + "/dp/" + asin.toUpperCase();
    const ti = t(q("#productTitle")) || t(q("#title"));
    if (ti) { out.title = ti; out.source = "amazon"; }
    if (out.price == null) {
      for (const sel of ["#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen", "#corePrice_feature_div .priceToPay .a-offscreen", ".priceToPay .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen", "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
        "#apex_desktop .a-price:not(.a-text-price) .a-offscreen", "#price_inside_buybox", "#priceblock_ourprice", "#priceblock_dealprice", ".a-price:not(.a-text-price) .a-offscreen"]) {
        const v = t(q(sel));
        if (/\d/.test(v)) { out.price = v; out.currency = /€|EUR/.test(v) ? "EUR" : /\$|USD/.test(v) ? "USD" : /£|GBP/.test(v) ? "GBP" : ""; break; }
      }
    }
    const im = q("#landingImage") || q("#imgBlkFront") || q("#imgTagWrapperId img") || q("#main-image-container img");
    if (im && !out.image) {
      let src = im.getAttribute("data-old-hires") || "";
      if (!src) { try { const d = JSON.parse(im.getAttribute("data-a-dynamic-image") || "{}"); src = Object.keys(d).sort((x, y) => (d[y][0] || 0) - (d[x][0] || 0))[0] || ""; } catch (e) { /* ignoré */ } }
      out.image = src || im.getAttribute("src") || "";
    }
    if (/indisponible|currently unavailable/i.test(t(q("#availability")) + " " + t(q("#outOfStock")))) out.stockOut = true;
    out.siteName = out.siteName || "Amazon." + location.hostname.split(".").slice(-1)[0];
  }

  // 2 ter) Options choisies sur la page (modèle, taille, couleur…) : « Libellé : valeur »
  out.variant = "";
  try {
    const vis = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const clean = s => String(s || "").replace(/\s+/g, " ").replace(/[:：]\s*$/, "").trim();
    const found = [], seen = new Set();
    const push = (label, value) => {
      label = clean(label).slice(0, 30); value = clean(value).slice(0, 60);
      if (!value || /^(s[ée]lection|choisir|choose|select|--|-)/i.test(value) || value.length < 1) return;
      const k = (label + "|" + value).toLowerCase();
      if (seen.has(k) || found.length >= 5) return; seen.add(k);
      found.push(label ? label + " : " + value : value);
    };
    if (/(^|\.)amazon\.[a-z.]+$/i.test(location.hostname)) {
      document.querySelectorAll('#twister [id^="variation_"], #twister_feature_div [id^="variation_"]').forEach(box => {
        if (!vis(box)) return;
        const lab = box.querySelector(".a-form-label"), sel = box.querySelector(".selection");
        if (lab && sel) { push(lab.textContent, sel.textContent); return; }
        const dd = box.querySelector("select");
        if (dd && dd.selectedIndex > 0) push(lab && lab.textContent, dd.options[dd.selectedIndex].textContent);
      });
      document.querySelectorAll('[id^="inline-twister-expanded-dimension-text-"]').forEach(el => {
        const row = el.closest('[id^="inline-twister-row-"]'), l = row && row.querySelector('[id^="inline-twister-dim-title-"]');
        push(l && l.textContent, el.textContent);
      });
    }
    if (!found.length) {
      // Listes déroulantes dont une valeur est choisie (hors liste d'options vide)
      document.querySelectorAll("select").forEach(s => {
        if (!vis(s) || s.selectedIndex < 1 || /quantit|qty|quantity|sort|tri|langue|country|pays/i.test((s.name || "") + (s.id || ""))) return;
        const l = (s.id && document.querySelector(`label[for="${CSS.escape(s.id)}"]`)) || s.closest("label") || null;
        push((l && l.textContent) || s.getAttribute("aria-label") || s.name || "", s.options[s.selectedIndex].textContent);
      });
      // Boutons radio cochés
      document.querySelectorAll('input[type="radio"]:checked').forEach(r => {
        if (/pay|livraison|delivery|shipping|ship|garantie|warranty|assurance/i.test((r.name || "") + (r.id || ""))) return;
        const g = r.closest("fieldset"), leg = g && g.querySelector("legend");
        const l = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label");
        push(leg && leg.textContent, (l && l.textContent) || r.value);
      });
      // Pastilles marquées « sélectionnées » (aria)
      document.querySelectorAll('[role="radio"][aria-checked="true"], button[aria-pressed="true"], [role="option"][aria-selected="true"]').forEach(b => {
        if (!vis(b) || b.closest("nav,header,footer")) return;
        const g = b.closest('[role="radiogroup"],fieldset,[aria-labelledby]');
        const lid = g && g.getAttribute("aria-labelledby"), le = lid && document.getElementById(lid.split(" ")[0]);
        push((le && le.textContent) || (g && g.getAttribute("aria-label")) || "", b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent);
      });
    }
    // Couleur, taille, modèle déclarés dans les données structurées
    if (!found.length && prod) {
      for (const [k, l] of [["model", "Modèle"], ["color", "Couleur"], ["size", "Taille"]]) {
        const v = first(prod[k]); push(l, typeof v === "string" ? v : (v && v.name) || "");
      }
    }
    out.variant = found.join(" · ").slice(0, 120);
  } catch (e) { /* options illisibles : ignoré */ }

  // 3) Titre, image, site
  if (!out.title) out.title = meta("og:title", "twitter:title") || text(document.querySelector("h1")) || document.title || "";
  if (!out.image) out.image = meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
  out.siteName = meta("og:site_name", "application-name") || out.siteName;
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
