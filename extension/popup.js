import { parsePrice, eur, isMarket, storeFromHost, cleanUrl, buildOffers, totalOf, dupOf } from "./lib.js";
import { api, store, rpc, search } from "./api.js";

const $ = id => document.getElementById(id);
const show = id => { for (const v of ["vSetup", "vMain", "vDone"]) $(v).hidden = v !== id; };
let cfg = {}, page = null, gifts = [], busy = false, dupAck = false, marketPage = false;

async function currentTab() {
  const id = new URLSearchParams(location.search).get("tab");     // pour les tests : onglet donné
  if (id) return api.tabs.get(+id);
  const [t] = await api.tabs.query({ active: true, currentWindow: true });
  return t;
}

// Lecture de la page : uniquement après le clic sur l'icône (permission « activeTab »)
async function readPage(tab) {
  if (!tab || !/^https?:\/\//i.test(tab.url || "")) return { url: "", unreadable: true };
  try {
    const [r] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    return r && r.result ? r.result : { url: tab.url, unreadable: true };
  } catch (e) { return { url: tab.url, title: tab.title || "", unreadable: true }; }
}

function setThumb(src) {
  const t = $("thumb"); t.textContent = "";
  if (/^https?:\/\//.test(src || "")) {
    const i = document.createElement("img"); i.alt = ""; i.referrerPolicy = "no-referrer";
    i.src = src.replace(/^http:/, "https:"); i.onerror = () => { t.textContent = "🎁"; };
    t.appendChild(i);
  } else t.textContent = "🎁";
}

function warn(msg) { $("warn").hidden = !msg; $("warn").textContent = msg || ""; }

async function init() {
  cfg = await store.get();
  if (!cfg.site || !cfg.code || !cfg.key) { show("vSetup"); return; }
  show("vMain");
  const tab = await currentTab();
  const raw = await readPage(tab);
  const url = cleanUrl(raw.url || (tab && tab.url) || "");
  const host = url ? new URL(url).hostname : "";
  const cur = String(raw.currency || "").toUpperCase();
  const price = parsePrice(raw.price);
  page = {
    url, host, image: raw.image || "", gtin: raw.gtin || "", stockOut: !!raw.stockOut,
    store: host ? storeFromHost(host, raw.siteName) : "",
    price: !cur || cur === "EUR" ? price : null, foreignCur: cur && cur !== "EUR" ? cur : "",
  };
  marketPage = !!url && isMarket(page.store, url);
  $("reading").hidden = true; $("fields").hidden = false;
  // La base refuse les noms de plus de 120 caractères (titres Amazon très longs) : on coupe proprement, sur un mot
  const shorten = t => { t = String(t || "").trim(); if (t.length <= 120) return t; const c = t.slice(0, 120), i = Math.max(c.lastIndexOf(" "), c.lastIndexOf(",")); return (i > 60 ? c.slice(0, i) : c).replace(/[\s,;:\-–|]+$/, ""); };
  $("title").value = shorten(raw.title || (tab && tab.title) || "");
  $("price").value = page.price != null ? String(page.price).replace(".", ",") : "";
  $("storeName").textContent = page.store || "Page non lisible";
  $("srcNote").textContent = raw.unreadable ? "Cette page n'a pas pu être lue : remplis les champs." : (page.price != null ? "Prix lu sur la page, à vérifier." : "Prix non trouvé : saisis-le.");
  $("note").value = String(raw.variant || "").slice(0, 500);   // modèle, taille… choisis sur la page
  setThumb(page.image);
  $("srch").checked = !!cfg.search;
  if (page.foreignCur) warn(`Le prix de la page est en ${page.foreignCur} : saisis le prix en euros.`);
  else if (page.stockOut) warn("La page indique une rupture de stock.");
  if (marketPage) {
    $("srch").checked = true; $("srch").disabled = true;
    $("srchHint").textContent = "Place de marché, site d'occasion ou comparateur : son prix n'est pas présenté comme une offre. La recherche (2 recherches du mois) cherche les marchands neufs.";
  }
  $("title").focus(); $("title").select();
  // Liste existante : alerte de doublon (lecture seule)
  try {
    const d = await rpc(cfg, "noel_get", { p_code: cfg.code });
    if (d.role !== "owner") throw Object.assign(new Error("Le code propriétaire est refusé."), { code: "denied" });
    gifts = d.gifts || [];
    checkDup();
  } catch (e) { if (e.code === "denied") $("err").textContent = e.message + " Ouvre les réglages pour le corriger."; }
}

function checkDup() {
  const g = dupOf(gifts, $("title").value, page && page.url);
  if (g) warn(`« ${g.title} » est déjà dans ta liste. Touche « Ajouter quand même » pour confirmer.`);
  else if (!page.foreignCur && !page.stockOut) warn("");
  return g;
}
$("title").addEventListener("input", () => { dupAck = false; $("add").textContent = "Ajouter à la liste"; checkDup(); });

$("vMain").addEventListener("submit", async e => {
  e.preventDefault();
  if (busy) return;
  $("err").textContent = "";
  const title = $("title").value.trim();
  if (!title) { $("err").textContent = "Donne un nom au cadeau."; $("title").focus(); return; }
  const raw = $("price").value.trim();
  const userPrice = raw === "" ? null : parsePrice(raw);
  if (raw !== "" && userPrice == null) { $("err").textContent = "Le prix n'est pas valide."; $("price").focus(); return; }
  if (checkDup() && !dupAck) { dupAck = true; $("add").textContent = "Ajouter quand même"; return; }
  const wantSearch = $("srch").checked;
  if (userPrice == null && !wantSearch) { $("err").textContent = "Ajoute un prix : un cadeau sans prix n'est pas proposé à la famille."; $("price").focus(); return; }

  busy = true; $("add").disabled = true;
  try {
    let s = null;
    if (wantSearch) {
      $("add").textContent = "Recherche des prix…";
      try { s = await search(cfg, page.url || title); }
      catch (e) { if (userPrice == null) throw new Error("La recherche a échoué et aucun prix n'est saisi. Saisis le prix puis réessaie."); }
    }
    $("add").textContent = "Ajout…";
    const { offers, best } = buildOffers(s, page.url && userPrice != null ? { url: page.url, store: page.store, price: userPrice, stockOut: page.stockOut && userPrice === page.price } : null);
    const price = best ? totalOf(best) : userPrice;
    if (price == null) throw new Error("Aucun prix trouvé. Saisis le prix puis réessaie.");
    const image = /^https?:\/\//.test(page.image) ? page.image.replace(/^http:/, "https:") : ((s && /^https:\/\//.test(s.image || "")) ? s.image : "");
    const gtin = /^\d{8,14}$/.test(page.gtin) ? page.gtin : (s && /^\d{8,14}$/.test(s.gtin || "") ? s.gtin : null);
    await rpc(cfg, "noel_add", {
      p_code: cfg.code, p_title: title, p_url: page.url || (s && s.link) || "", p_note: $("note").value,
      p_image: image, p_price: price, p_store: (best ? best.store : page.store) || "", p_offers: offers.length ? offers : null,
      p_top: $("top").checked, p_gtin: gtin,
    });
    if (!marketPage) await store.set({ search: wantSearch });
    $("doneTxt").textContent = `« ${title} » est dans ta liste, à ${eur(price)}${best ? " chez " + best.store : ""}${offers.length > 1 ? " (" + offers.length + " marchands comparés)" : ""}.`;
    $("openList").href = cfg.site + "/gestion.html";
    show("vDone");
  } catch (err) {
    $("err").textContent = err.message + (err.code === "denied" ? " Ouvre les réglages." : "");
    $("add").textContent = "Ajouter à la liste";
  }
  busy = false; $("add").disabled = false;
});

$("gear").addEventListener("click", () => { api.runtime.openOptionsPage(); window.close(); });
$("openOpts").addEventListener("click", () => { api.runtime.openOptionsPage(); window.close(); });
$("close").addEventListener("click", () => window.close());
// Ne jamais rester bloqué sur « Lecture de la page… » (Firefox peut refuser une API : on affiche le formulaire à remplir à la main)
init().catch(e => {
  if (!$("vSetup").hidden) return;
  show("vMain"); $("reading").hidden = true; $("fields").hidden = false;
  if (!page) page = { url: "", host: "", image: "", gtin: "", stockOut: false, store: "", price: null, foreignCur: "" };
  $("err").textContent = "Lecture impossible (" + (e && e.message || e) + "). Remplis les champs à la main.";
});
