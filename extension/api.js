// Appels au site de la liste (adresse et code propriétaire saisis dans les réglages).
// La clé publique « anon » est lue dans la page d'accueil du site, où le serveur l'injecte :
// rien n'est écrit en dur dans l'extension.
import { MSG } from "./lib.js";

export const api = globalThis.browser ?? globalThis.chrome;
export const store = {
  async get() { return (await api.storage.local.get(["site", "code", "key", "search"])) || {}; },
  set(o) { return api.storage.local.set(o); },
  clear() { return api.storage.local.clear(); },
};

export async function fetchKey(site) {
  let r;
  try { r = await fetch(site + "/", { cache: "no-store", credentials: "omit" }); }
  catch (e) { throw new Error("Site injoignable. Vérifie l'adresse et ta connexion."); }
  if (!r.ok) throw new Error("Le site répond « " + r.status + " ». Vérifie l'adresse.");
  const html = await r.text();
  const m = html.match(/SUPABASE_KEY\s*=\s*"([^"]+)"/);
  if (!m || m[1] === "__SUPABASE_ANON_KEY__") throw new Error("Ce site ne ressemble pas à ta liste de Noël (clé publique introuvable).");
  return m[1];
}

const headers = key => ({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" });

export async function rpc(cfg, fn, args) {
  let r;
  try { r = await fetch(`${cfg.site}/rest/v1/rpc/${fn}`, { method: "POST", headers: headers(cfg.key), body: JSON.stringify(args), credentials: "omit" }); }
  catch (e) { throw new Error("Connexion impossible. Vérifie ta connexion internet puis réessaie."); }
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error("Une erreur est survenue (" + r.status + "). Réessaie dans un instant.");
  if (d && d.error) throw Object.assign(new Error(MSG[d.error] || "Une erreur est survenue. Réessaie dans un instant."), { code: d.error });
  return d;
}

// Recherche complète côté serveur : 2 recherches SerpAPI en général (voir CLAUDE.md du dépôt)
export async function search(cfg, query) {
  let r;
  try { r = await fetch(`${cfg.site}/functions/v1/noel-preview`, { method: "POST", headers: headers(cfg.key), body: JSON.stringify({ code: cfg.code, query }), credentials: "omit" }); }
  catch (e) { throw new Error("Recherche impossible pour le moment."); }
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) throw new Error("Recherche impossible pour le moment.");
  return d;
}
