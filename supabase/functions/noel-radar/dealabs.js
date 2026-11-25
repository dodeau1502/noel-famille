// Lecture du flux RSS Dealabs (module pur : aucune dépendance réseau, testable avec node).
// On ne lit QUE le flux RSS officiel. Jamais les pages de deals, la recherche, les API ni les liens /visit/ (voir CLAUDE.md).
import { decode, parsePrice } from "../noel-preview/parse.js";

const MAX_BYTES = 2_000_000, MAX_ITEMS = 200;

const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ");
// Contenu d'une balise, CDATA compris. Le texte hors CDATA est décodé (entités XML), le CDATA est pris tel quel.
function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  const c = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return c ? c[1] : decode(m[1]);
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")); return m ? decode(m[1]) : null; };

// → { items: Item[], self: string|null } ; flux vide, tronqué ou trop gros : items = [], jamais d'exception.
// Item = { guid, link, title, category, merchant|null, price|null, pubDate: Date, html }
export function parseFeed(xml) {
  try {
    const s = String(xml ?? "");
    if (!s || s.length > MAX_BYTES) return { items: [], self: null };
    const sm = s.match(/<atom:link\b[^>]*>/i);
    const self = sm && /rel\s*=\s*"self"/i.test(sm[0]) ? attr(sm[0], "href") : null;
    const blocks = [...s.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
    if (blocks.length > MAX_ITEMS) return { items: [], self };
    const items = [];
    for (const b of blocks) {
      const link = tagText(b, "link").trim();
      const guid = tagText(b, "guid").trim() || link;
      const title = decode(stripTags(tagText(b, "title"))).replace(/\s+/g, " ").trim();
      const t = Date.parse(tagText(b, "pubDate").trim());
      if (!guid || !title || !Number.isFinite(t)) continue;
      const mt = b.match(/<pepper:merchant\b[^>]*\/?>/i);
      const html = tagText(b, "description");
      items.push({
        guid, link, title,
        category: decode(stripTags(tagText(b, "category"))).trim(),
        merchant: mt ? (attr(mt[0], "name") || null) : null,
        price: mt ? parsePrice(attr(mt[0], "price")) : null,   // jamais déduit du titre
        pubDate: new Date(t),
        html: html.includes("&lt;") && !html.includes("<") ? decode(html) : html,
      });
    }
    return { items, self };
  } catch (_) {
    return { items: [], self: null };
  }
}

// Identifiant numérique en fin d'adresse du deal (« …-3469432 » → "3469432")
export function itemId(item) {
  const m = String(item?.guid || item?.link || "").replace(/[?#].*$/, "").replace(/\/+$/, "").match(/(\d+)$/);
  return m ? m[1] : null;
}

// --- Liens ----------------------------------------------------------------
const FORBIDDEN_HOSTS = ["dealabs.com", "pepper.com", "awin1.com", "tradedoubler.com", "effiliation.com", "bit.ly", "amzn.to", "tidd.ly", "ojrq.net", "linksynergy.com", "paidonresults.net", "clk.tradedoubler.com"];
const TRACKING = /^(utm_.*|awc|sv1|sv_campaign_id|tag|ref|ref_|affid|aff_id|clickref|gclid|fbclid|cmpid|curator_clanid|srsltid|msclkid|mc_cid|mc_eid)$/i;
const onHost = (h, d) => h === d || h.endsWith("." + d);
const ASIN_IN_PATH = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?#]|$)/;

// Adresse sans paramètres de suivi ; null si elle n'est pas https, si l'hôte est interdit (Dealabs, affiliation, liens courts) ou si c'est un lien /visit/.
// Amazon : réécrite en https://www.amazon.fr/dp/<ASIN> (autres Amazon et liens sans ASIN : null).
export function cleanLink(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch (_) { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (FORBIDDEN_HOSTS.some(d => onHost(host, d))) return null;
  if (/(^|\/)visit(\/|$)/i.test(u.pathname)) return null;
  if (/(^|\.)amazon\./.test(host)) {
    if (!onHost(host, "amazon.fr")) return null;
    const m = u.pathname.match(ASIN_IN_PATH);
    return m ? `https://www.amazon.fr/dp/${m[1]}` : null;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}

export const pad14 = g => String(g).replace(/\D/g, "").padStart(14, "0");

// --- Faits utiles tirés d'un deal --------------------------------------------
// → { asins, gtins (14 chiffres), mpns, links, ref30, soldBy }
export function extractFacts(item) {
  const html = String(item?.html ?? "");
  // Texte en lignes : les fins de paragraphe deviennent des sauts de ligne (une référence s'arrête à la fin de sa ligne)
  const lines = decode(stripTags(html.replace(/<\/(?:p|div|li|tr|h\d)>|<br\s*\/?>/gi, "\n"))).split("\n").map(l => l.replace(/[ \t\u00a0]+/g, " ").trim()).filter(Boolean);
  const text = lines.join(" ");
  const asins = new Set(), gtins = new Set(), links = [], mpns = [];

  for (const m of text.matchAll(/\bASIN\s*:?\s*([A-Z0-9]{10})\b/g)) asins.add(m[1]);
  const hrefs = [...html.matchAll(/href\s*=\s*"([^"]+)"/gi)].map(m => decode(m[1]));
  for (const h of hrefs) {
    let u; try { u = new URL(h); } catch (_) { continue; }
    if (/(^|\.)amazon\.fr$/i.test(u.hostname)) { const m = u.pathname.match(ASIN_IN_PATH); if (m) asins.add(m[1]); }
    const c = cleanLink(h);
    if (c && !links.includes(c)) links.push(c);
  }
  for (const m of text.matchAll(/(?:code article international|\bEAN\b|\bGTIN\b)\s*:?\s*(\d{8,14})\b/gi)) gtins.add(pad14(m[1]));

  // Référence constructeur : texte qui suit le libellé, sur la même ligne, 40 caractères au plus
  const LABEL = /(?:Référence fabricant|Référence|\bMPN\b|\bM-PID\b|Numéro de modèle|Numéro de pièce|Nom de modèle)\s*:\s*(.+)$/i;
  for (const line of lines) {
    const m = line.match(LABEL);
    if (!m) continue;
    const v = m[1].split(/\s{2,}|;|,\s|\.\s/)[0].trim().slice(0, 40);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ./_-]{2,}$/.test(v)) continue;
    if (!mpns.includes(v)) mpns.push(v);
    const compact = v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (compact !== v && !mpns.includes(compact)) mpns.push(compact);
  }

  let ref30 = null;
  const r1 = text.match(/prix le plus bas des 30 derniers jours[^0-9]{0,60}?(\d[\d\s.,]*\d|\d)\s*€/i);
  const r2 = text.match(/(\d[\d\s.,]*\d|\d)\s*€[^0-9]{0,60}?prix le plus bas des 30 derniers jours/i);
  const rv = r1 ? r1[1] : r2 ? r2[1] : null;
  if (rv) ref30 = parsePrice(rv);

  const sb = lines.map(l => l.match(/Vendu et expédié par\s+([^.;]{1,80})/i)).find(Boolean);
  return { asins: [...asins], gtins: [...gtins], mpns, links, ref30, soldBy: sb ? sb[1].trim().slice(0, 40) : null };
}

// Fait prêt pour le rapprochement : le deal + ses faits (+ lien et page du deal)
export function factOf(item) {
  const f = extractFacts(item);
  return { guid: item.guid, title: item.title, merchant: item.merchant, price: item.price, pubDate: item.pubDate, html: item.html, page_url: item.link || null, ...f };
}
