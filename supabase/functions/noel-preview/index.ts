import { extract, isPrivateIp, badHostname } from "./parse.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function isOwner(code: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_ANON_KEY")!;
  const r = await fetch(`${url}/rest/v1/rpc/noel_get`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: code }),
  });
  if (!r.ok) return false;
  const d = await r.json().catch(() => null);
  return d?.role === "owner";
}

async function assertPublic(u: URL) {
  if (u.protocol !== "https:") throw new Error("Seuls les liens https sont acceptés.");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new Error("Lien non accepté.");
  if (badHostname(u.hostname)) throw new Error("Lien non accepté.");
  const ips: string[] = [];
  for (const t of ["A", "AAAA"] as const) {
    try { ips.push(...(await Deno.resolveDns(u.hostname, t))); } catch (_) { /* pas d'enregistrement de ce type */ }
  }
  if (!ips.length || ips.some(isPrivateIp)) throw new Error("Lien non accepté.");
}

async function readLimited(res: Response, max = 1_500_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder("utf-8", { fatal: false });
  let out = "", total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= max || /<\/head>/i.test(out) && total > 200_000) { try { await reader.cancel(); } catch (_) {} break; }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  let body: { code?: string; url?: string };
  try { body = await req.json(); } catch (_) { return json({ error: "requête invalide" }, 400); }
  const code = String(body.code ?? ""), raw = String(body.url ?? "").trim();
  if (!code || !raw || raw.length > 1000) return json({ error: "requête invalide" }, 400);
  if (!(await isOwner(code))) return json({ error: "non autorisé" }, 403);

  try {
    let url = new URL(raw);
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      await assertPublic(url);
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      break;
    }
    if (!res || !res.ok) return json({ ok: false, reason: "Le site n'a pas répondu à la lecture automatique." });
    const type = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(type)) return json({ ok: false, reason: "Ce lien n'est pas une page web." });
    const html = await readLimited(res);
    const info = extract(html, url.toString());
    return json({ ok: true, ...info, finalUrl: url.toString() });
  } catch (e) {
    return json({ ok: false, reason: e instanceof Error && /Lien non accepté|https/.test(e.message) ? e.message : "Lecture impossible pour ce lien." });
  }
});
