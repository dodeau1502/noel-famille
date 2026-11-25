// Relevé de prix par marchand (lot O) : module pur, sans réseau. Aucune donnée de réservation (règle 1).
// obs : [{ mkey, total, verified, stock?, at }] ; at = date ISO.
const DAY = 86400e3;
const t = (o) => new Date(o.at).getTime();

// Clé de marchand : nom sans accents ni ponctuation (même calcul que keyOf de la page)
export function mkeyOf(store) {
  return String(store || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "").slice(0, 60);
}

// Faut-il écrire un nouveau relevé ? Premier relevé, total / stock / état vérifié changé, ou dernier relevé de plus de 20 h.
export function shouldRecord(last, next, now = new Date()) {
  if (!last) return true;
  if (last.total !== next.total || (last.stock || "") !== (next.stock || "") || !!last.verified !== !!next.verified) return true;
  return now.getTime() - t(last) > 20 * 3600e3;
}

// Plus bas total VÉRIFIÉ chez ce marchand sur 30 jours : { total, at } ou null (à égalité, le plus récent)
export function low30(obs, mkey, now = new Date()) {
  let best = null;
  for (const o of obs || []) {
    if (o.mkey !== mkey || !o.verified || now - t(o) > 30 * DAY || t(o) > now.getTime()) continue;
    if (!best || o.total < best.total || (o.total === best.total && t(o) > t(best))) best = o;
  }
  return best ? { total: best.total, at: best.at } : null;
}

// Baisse qui ramène seulement au niveau d'avant une hausse : total vérifié actuel < relevé précédent,
// mais >= plus bas vérifié des jours J-30 à J-2. Renvoie { at } (date de ce plus bas) ou null.
export function riseBeforeDrop(obs, mkey, now = new Date()) {
  const v = (obs || []).filter((o) => o.mkey === mkey && o.verified && t(o) <= now.getTime()).sort((a, b) => t(a) - t(b));
  if (v.length < 2) return null;
  const cur = v[v.length - 1], prev = v[v.length - 2];
  if (!(cur.total < prev.total)) return null;
  const older = v.filter((o) => now - t(o) <= 30 * DAY && now - t(o) >= 2 * DAY);
  if (!older.length) return null;
  const min = older.reduce((a, b) => (b.total < a.total || (b.total === a.total && t(b) > t(a)) ? b : a));
  return cur.total >= min.total ? { at: min.at } : null;
}

// Prix anormal : moins de la moitié de la médiane des totaux vérifiés (30 jours), avec au moins 3 relevés.
export function anomaly(obs, total, now = new Date()) {
  const xs = (obs || []).filter((o) => o.verified && now - t(o) <= 30 * DAY).map((o) => o.total).sort((a, b) => a - b);
  if (xs.length < 3) return false;
  const m = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return total < 0.5 * m;
}

// Méthode d'un relevé d'après l'offre
export function methodOf(o) {
  if (o.verified) return o.via === "dealabs" ? "dealabs" : o.via === "keepa" ? "keepa" : "page";
  return o.via === "manual" ? "manual" : o.via === "dealabs" ? "dealabs" : o.via === "keepa" ? "keepa" : "google";
}
