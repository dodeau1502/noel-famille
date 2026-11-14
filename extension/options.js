import { normalizeSite, extractCode } from "./lib.js";
import { api, store, fetchKey, rpc } from "./api.js";
const $ = id => document.getElementById(id);

(async () => {
  const c = await store.get();
  if (c.site) { $("site").value = c.site; $("state").textContent = c.code ? "Réglages enregistrés. Le code n'est pas réaffiché : saisis-le de nouveau pour le changer." : ""; }
})();

$("f").addEventListener("submit", async e => {
  e.preventDefault();
  const site = normalizeSite($("site").value), code = extractCode($("code").value);
  const msg = $("msg"); msg.textContent = "";
  if (!site) { msg.textContent = "Adresse invalide."; return; }
  const old = await store.get();
  const codeFinal = code || (old.site === site ? old.code : "");
  if (!codeFinal) { msg.textContent = "Saisis ton code propriétaire."; return; }
  // Autorisation d'appeler ton site : demandée ici, au clic (obligatoire pour que le navigateur l'accepte)
  let granted = false;
  try { granted = await api.permissions.request({ origins: [site + "/*"] }); } catch (e) { msg.textContent = "Autorisation impossible : " + e.message; return; }
  if (!granted) { msg.textContent = "Sans cette autorisation, l'extension ne peut pas joindre ton site."; return; }
  $("save").disabled = true; msg.textContent = "Vérification…";
  try {
    const key = await fetchKey(site);
    const d = await rpc({ site, key }, "noel_get", { p_code: codeFinal });
    if (d.role !== "owner") throw new Error("Ce code n'est pas celui du propriétaire.");
    await store.set({ site, code: codeFinal, key });
    $("code").value = ""; $("state").textContent = "Réglages enregistrés.";
    msg.textContent = "Connecté à « " + (d.title || site) + " ». Tu peux fermer cet onglet.";
  } catch (err) { msg.textContent = err.message; }
  $("save").disabled = false;
});

$("forget").addEventListener("click", async () => {
  await store.clear(); $("site").value = ""; $("code").value = ""; $("state").textContent = "";
  $("msg").textContent = "Réglages effacés.";
});
