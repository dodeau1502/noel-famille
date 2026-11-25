// Conditions d'un prix de deal (module pur). Un prix « sous conditions » n'est jamais fusionné dans les offres ni choisi comme « Le moins cher ».
import { decode } from "../noel-preview/parse.js";
import { norm } from "../noel-preview/offers.js";

const toLines = html => decode(String(html ?? "").replace(/<\/(?:p|div|li|tr|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "))
  .split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);

// Le code se lit en MAJUSCULES (casse d'origine) : « code promo valable » ne donne pas de code
const CODE = /(?:via\s+(?:le\s+)?code(?:\s+promo)?|[Cc]ode\s+promo(?:\s+à\s+saisir|\s+à\s+utiliser)?|[Cc]ode\s+de\s+réduction|[Cc]ode)\s*:?\s*([A-Z0-9]{4,20})\b/g;

// → [{ type, label, code? }] ; au plus une condition par type
export function conditionsOf(title, html) {
  const t = String(title ?? "");
  const lines = toLines(html);
  const body = lines.join(" ");
  const head = lines.slice(0, 2).join(" ").slice(0, 200);       // « en tête » de la description
  const nt = norm(t), nb = norm(body), nh = norm(head);
  const out = [];
  const add = c => { if (!out.some(x => x.type === c.type)) out.push(c); };

  for (const src of [t, body]) {
    for (const m of src.matchAll(CODE)) {
      if (/^\d+$/.test(m[1]) || !/[A-Z]/.test(m[1])) continue;     // un nombre n'est pas un code
      add({ type: "code", label: `Code ${m[1]}`, code: m[1] });
    }
  }
  if (/via coupon|coupon a activer|bon de reduction/.test(nt + " " + nb)) add({ type: "coupon", label: "Coupon à activer" });
  if (/\bodr\b|offre de remboursement|remboursement differe/.test(nt + " " + nb)) {
    const m = body.match(/(\d+(?:[.,]\d{1,2})?)\s*€[^.]{0,40}rembours/i) || body.match(/rembours[^.]{0,40}?(\d+(?:[.,]\d{1,2})?)\s*€/i);
    add({ type: "odr", label: "Remboursement différé" + (m ? ` (${m[1].replace(".", ",")} €)` : "") });
  }
  // « membre » : seulement dans le titre ou en tête de la description. « Livraison gratuite pour les membres Prime » plus bas
  // décrit la livraison, pas un prix réservé.
  if (/\[prime\]/.test(nt)) add({ type: "membre", label: "Prime" });
  else if (/\bmembres?\b|carte (de )?fidelite|adherent|cdiscount a volonte/.test(nt) || /reserve(?:e|es)? aux (membres|adherents|abonnes)|cdiscount a volonte/.test(nh)) {
    add({ type: "membre", label: "Réservé aux membres" });
  }
  if (/nouveaux clients|nouveaux inscrits|1re commande|1ere commande|premiere commande|nouveaux abonnes/.test(nt + " " + nb)) add({ type: "nouveaux", label: "Nouveaux clients" });
  if (/\[etudiant|(^|\s)-\s?26 ans|18-24 ans|moins de 26 ans/.test(nt + " " + nb)) add({ type: "public", label: "Public restreint" });
  if (/en magasin|dans votre magasin|\blocal\b/.test(nt) || /en magasin|dans votre magasin/.test(nh)) add({ type: "magasin", label: "En magasin" });
  if (/cagnotte|points fidelite|cash ?back/.test(nt + " " + nb)) add({ type: "cagnotte", label: "Avantage fidélité (non déduit)" });
  return out;
}

// Une seule condition autre que « cagnotte » (informative) rend le prix conditionnel
export const isConditional = conds => (conds || []).some(c => c && c.type !== "cagnotte");
