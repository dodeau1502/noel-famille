// Planificateur interne : tâches périodiques du radar des promotions, dans le même processus que le serveur.
// Actif seulement si JOBS_ENABLED=1 (production). Le développement (noel-dev-app) le laisse vide : on ne lit pas Dealabs deux fois.
// Un verrou en base (noel_job_lease) évite deux exécutions simultanées pendant un redéploiement (ancien et nouveau conteneur).
// Une erreur n'arrête jamais le serveur. Aucune tâche ne lit les réservations.
import { runDealabs, runKeepa, runMail, isFast } from "../supabase/functions/noel-radar/index.ts";
import { runSelftest } from "../supabase/functions/noel-radar/selftest.ts";
import { runSweep } from "../supabase/functions/noel-radar/sweep.ts";
import { rpc } from "../supabase/functions/noel-radar/db.ts";

const RUN_TIMEOUT_MS = 60_000;
const HOLDER = `${Deno.env.get("HOSTNAME") ?? "conteneur"}-${crypto.randomUUID().slice(0, 8)}`;

type Task = {
  name: string;                       // nom du verrou (et de la source dans noel_sources)
  leaseSec: number;
  enabled: () => boolean;
  delay: (now: Date) => number;       // millisecondes avant la prochaine exécution (sans décalage aléatoire)
  run: () => Promise<unknown>;
  fixed?: boolean;                    // heure fixe (purge, test, balayage) : décalage de 0 à 5 min seulement, pas ±10 %
  timeoutMs?: number;                 // 60 s par défaut
};

// Délai avant la prochaine heure fixe (h:m, heure de Paris), quelle que soit l'heure du serveur
export function nextDailyDelay(now: Date, h: number, m: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((x) => [x.type, Number(x.value)]));
  const cur = p.hour * 3600 + p.minute * 60 + p.second;
  let d = h * 3600 + m * 60 - cur;
  if (d <= 0) d += 86400;
  return d * 1000;
}

// Délai avant le prochain jour de semaine donné (0 = dimanche … 1 = lundi) à h:m, heure de Paris
export function nextWeeklyDelay(now: Date, dow: number, h: number, m: number): number {
  let d = nextDailyDelay(now, h, m);
  for (let i = 0; i < 8; i++, d += 86400_000) {
    const wd = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short" }).format(new Date(now.getTime() + d + 60_000));
    if (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) === dow) return d;
  }
  return d;
}

// ±10 % : les tâches ne se synchronisent pas
export const jitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2));
const wait = (t: Task, ms: number) => (t.fixed ? ms + Math.round(Math.random() * 300_000) : jitter(ms));

export const TASKS: Task[] = [
  { name: "dealabs:tous", leaseSec: 90, enabled: () => true, delay: (now) => (isFast(now) ? 60_000 : 120_000), run: () => runDealabs(new Date(), { feed: "tous" }) },
  { name: "dealabs:hot", leaseSec: 120, enabled: () => true, delay: () => 600_000, run: () => runDealabs(new Date(), { feed: "hot" }) },
  { name: "keepa", leaseSec: 300, enabled: () => !!Deno.env.get("KEEPA_RSS_URL"), delay: () => 900_000, run: () => runKeepa() },
  { name: "mail", leaseSec: 240, enabled: () => !!Deno.env.get("IMAP_HOST"), delay: () => 300_000, run: () => runMail() },
  { name: "google", fixed: true, leaseSec: 3600, timeoutMs: 1_800_000, enabled: () => !!Deno.env.get("SERPAPI_KEY"), delay: (now) => nextWeeklyDelay(now, 1, 4, 10), run: () => runSweep() },
  { name: "selftest", fixed: true, leaseSec: 300, enabled: () => true, delay: (now) => nextDailyDelay(now, 7, 15), run: () => runSelftest() },
  { name: "purge", fixed: true, leaseSec: 600, enabled: () => true, delay: (now) => nextDailyDelay(now, 4, 30), run: () => rpc("noel_radar_purge", {}) },
];

async function runOnce(t: Task) {
  let got: unknown = false;
  try { got = await rpc("noel_job_lease", { p_name: t.name, p_seconds: t.leaseSec, p_holder: HOLDER }); } catch (_) { return; }
  if (got !== true) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([t.run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("délai dépassé")), t.timeoutMs ?? RUN_TIMEOUT_MS); })]);
  } catch (e) {
    console.log("noel-jobs " + JSON.stringify({ task: t.name, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  } finally { clearTimeout(timer); }
}

function loop(t: Task, first: number) {
  setTimeout(async () => {
    try { if (t.enabled()) await runOnce(t); } catch (_) { /* jamais d'arrêt du serveur */ }
    loop(t, wait(t, t.delay(new Date())));
  }, first);
}

export function startJobs() {
  if (Deno.env.get("JOBS_ENABLED") !== "1") return;
  if (!Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) { console.log("noel-jobs : SUPABASE_URL ou clé de service manquante, tâches désactivées"); return; }
  console.log("noel-jobs : démarrage " + JSON.stringify(TASKS.filter((t) => t.enabled()).map((t) => t.name)));
  TASKS.forEach((t, i) => loop(t, t.fixed ? wait(t, t.delay(new Date())) : 5_000 + i * 7_000 + Math.random() * 5_000));
}
