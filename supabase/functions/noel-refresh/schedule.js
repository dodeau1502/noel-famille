// Fréquence de relecture adaptée (lot P) : module pur, sans réseau.
// CONFIDENTIALITÉ (règle 1) : nextCheck ne lit QUE les quatre clés ci-dessous. Aucune donnée de réservation (pris, acheté, payé) n'y entre.
const MIN = 60e3, H = 3600e3;
export const INPUT_KEYS = ["lastSignalAt", "lastChangeAt", "readableCount", "inHighPeriod"];

// Sites que l'on ne sait pas lire : aucun prix à en tirer, donc jamais relus
const UNREADABLE = /(^|\.)(amazon|fnac|darty|sony|lego|boulanger|decathlon|uniqlo)\./;
export const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (_) { return ""; } };
export const isUnreadable = (url) => UNREADABLE.test(hostOf(url) + ".");

// Première règle qui s'applique. rand() ∈ [0,1[ : décalage aléatoire de ±10 % pour ne pas lire toutes les fiches ensemble.
export function nextCheck(input, now = new Date(), rand = Math.random) {
  const lastSignalAt = input.lastSignalAt, lastChangeAt = input.lastChangeAt, readableCount = input.readableCount, high = input.inHighPeriod;
  const age = (d) => (d ? now.getTime() - new Date(d).getTime() : Infinity);
  let delay;
  if (!(readableCount > 0)) delay = 6 * H;                  // rien de lisible : relire ne sert à rien
  else if (age(lastSignalAt) < 6 * H) delay = 15 * MIN;
  else if (age(lastChangeAt) < 48 * H) delay = 30 * MIN;
  else if (high) delay = 45 * MIN;
  else delay = 60 * MIN;
  delay *= 0.9 + 0.2 * rand();
  return new Date(now.getTime() + delay);
}

// « 2026-11-27/2026-12-01,2026-12-14/2026-12-24 » (jours inclus, heure de Paris approchée à midi UTC)
export function inHighPeriod(now, spec) {
  for (const part of String(spec || "").split(",")) {
    const [a, b] = part.trim().split("/");
    const s = Date.parse(a + "T00:00:00+01:00"), e = Date.parse(b + "T23:59:59+01:00");
    if (!isNaN(s) && !isNaN(e) && now.getTime() >= s && now.getTime() <= e) return true;
  }
  return false;
}

// Dernier changement du total vérifié (par marchand), d'après les relevés [{mkey,total,verified,at}] : date ISO ou null
export function lastChange(obs) {
  const by = new Map(); let last = null;
  for (const o of [...(obs || [])].filter((x) => x.verified).sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const p = by.get(o.mkey);
    if (p !== undefined && p !== o.total) last = o.at;
    by.set(o.mkey, o.total);
  }
  return last;
}

// Offre à relire ce passage ? Site illisible : jamais. Après 3 échecs consécutifs : au plus une fois par 24 h. force : bouton du propriétaire.
export function offerDue(o, now = new Date(), force = false) {
  if (!o || !o.url || isUnreadable(o.url)) return false;
  if (force) return true;
  if ((o.fails || 0) >= 3) return !o.tried_at || now.getTime() - new Date(o.tried_at).getTime() >= 24 * H;
  return true;
}

// Offres sur un marchand lisible (pour readableCount)
export const readableCount = (offers) => (Array.isArray(offers) ? offers : []).filter((o) => o && o.url && !isUnreadable(o.url)).length;

// Plafond par domaine : 1 lecture toutes les 20 s et 60 par heure. reserve() renvoie l'attente en ms, ou -1 si le plafond horaire est atteint
// ou si l'attente dépasse maxWaitMs.
export function registrable(host) {
  const p = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (p.length < 2) return "";
  const n = p.length >= 3 && p[p.length - 1].length === 2 && new Set(["co", "com", "org", "net", "gov", "ac"]).has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}
export class DomainThrottle {
  constructor(gapMs = 20e3, perHour = 60) { this.gap = gapMs; this.cap = perHour; this.free = new Map(); this.hist = new Map(); }
  reserve(host, nowMs, maxWaitMs = 60e3) {
    const d = registrable(host) || host;
    const h = (this.hist.get(d) || []).filter((t) => nowMs - t < H);
    if (h.length >= this.cap) { this.hist.set(d, h); return -1; }
    const slot = Math.max(nowMs, this.free.get(d) || 0);
    if (slot - nowMs > maxWaitMs) return -1;
    this.free.set(d, slot + this.gap); h.push(slot); this.hist.set(d, h);
    return slot - nowMs;
  }
}

// Plafond global : REFRESH_MAX_READS_H lectures par heure. src : { window_start, n } ; renvoie { allowed, src }
export function takeReads(src, want, max, now = new Date()) {
  const fresh = !src || !src.window_start || now.getTime() - new Date(src.window_start).getTime() >= H;
  const used = fresh ? 0 : src.n || 0;
  const allowed = Math.max(0, Math.min(want, max - used));
  return { allowed, src: { window_start: fresh ? now.toISOString() : src.window_start, n: used + allowed } };
}
