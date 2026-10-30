// Lecture d'une page produit : titre, photo, prix, boutique (sans dépendance)
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
export function decode(s) {
  return String(s ?? "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENT[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

export function metaTags(html) {
  const out = {};
  const re = /<meta\s+([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const ar = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content !== undefined && !(key in out)) out[key] = decode(attrs.content);
  }
  return out;
}

export function parsePrice(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) && v >= 0 && v < 100000 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // le dernier séparateur est la décimale
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1 && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

function walk(node, found) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, found)); return; }
  const t = [].concat(node["@type"] || []).map(String);
  if (t.some(x => /Product/i.test(x))) found.products.push(node);
  if (t.some(x => /Offer/i.test(x))) found.offers.push(node);
  for (const k of Object.keys(node)) if (typeof node[k] === "object") walk(node[k], found);
}

export function jsonLd(html) {
  const found = { products: [], offers: [] };
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1].trim()), found); } catch (e) { /* JSON-LD invalide, on ignore */ }
  }
  return found;
}

function firstImage(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (typeof v === "object") return v.url || v.contentUrl || null;
  return null;
}

export function extract(html, finalUrl) {
  const meta = metaTags(html);
  const ld = jsonLd(html);
  const prod = ld.products[0] || {};
  let title = meta["og:title"] || meta["twitter:title"] || prod.name || "";
  if (!title) { const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) title = decode(t[1]); }
  let image = meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || firstImage(prod.image) || "";
  try { image = image ? new URL(decode(image), finalUrl).toString() : ""; } catch (e) { image = ""; }
  if (!image.startsWith("https://")) image = "";

  let price = null, currency = "";
  const cand = [
    [meta["product:price:amount"] || meta["og:price:amount"] || meta["product:sale_price:amount"], meta["product:price:currency"] || meta["og:price:currency"]],
  ];
  for (const o of ld.offers.concat([].concat(prod.offers || []))) {
    const spec = o.priceSpecification && !Array.isArray(o.priceSpecification) ? o.priceSpecification : {};
    cand.push([o.price ?? o.lowPrice ?? spec.price, o.priceCurrency || spec.priceCurrency]);
  }
  for (const [p, c] of cand) {
    const n = parsePrice(p);
    if (n !== null && n > 0) { price = n; currency = String(c || "EUR").toUpperCase(); break; }
  }
  // On n'affiche que des prix en euros pour éviter les erreurs de lecture
  if (currency && currency !== "EUR") price = null;

  let store = meta["og:site_name"] || "";
  if (!store) { try { store = new URL(finalUrl).hostname.replace(/^www\./, ""); } catch (e) {} }
  return { title: title.slice(0, 120), image, price, store: store.slice(0, 80) };
}

export function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || l.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function badHostname(h) {
  const l = h.toLowerCase();
  if (l === "localhost" || l.endsWith(".localhost") || l.endsWith(".local") || l.endsWith(".internal") || l.endsWith(".lan")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(l) || l.includes(":") || l.startsWith("[")) return true; // adresses IP directes refusées
  return !l.includes(".");
}
