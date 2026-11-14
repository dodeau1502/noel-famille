// Serveur unique : page (site/), fonctions noel-preview / noel-refresh et relais vers PostgREST.
// Public (port PORT, 8000) : GET fichiers de site/, POST /rest/v1/rpc/noel_*, POST /functions/v1/noel-{preview,refresh}.
// Interne (127.0.0.1:INTERNAL_PORT, 8001, non publié) : relais complet /rest/v1/* utilisé par les fonctions (SUPABASE_URL).
import { handler as preview } from "../supabase/functions/noel-preview/index.ts";
import { handler as refresh } from "../supabase/functions/noel-refresh/index.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const INTERNAL_PORT = Number(Deno.env.get("INTERNAL_PORT") ?? 8001);
const POSTGREST = (Deno.env.get("POSTGREST_URL") ?? "http://postgrest:3000").replace(/\/$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SITE = new URL("../site/", import.meta.url);
const MAX_BODY = 1_000_000;

// Environnement dev uniquement : barre d'outils de retours (voir vps-infra/dev-feedback). En production, APP_ENV n'est pas « dev »
// et rien n'est injecté. La décision est prise ICI, côté serveur : le navigateur ne peut pas l'activer.
const APP_ENV = Deno.env.get("APP_ENV") ?? "production";
const TOOLBAR_SRC = Deno.env.get("DEV_TOOLBAR_SRC") ?? "";
const TOOLBAR_TOKEN = Deno.env.get("DEV_TOOLBAR_TOKEN") ?? "";
const APP_COMMIT = Deno.env.get("APP_COMMIT") ?? "";
const attr = (s: string) => s.replace(/[&"'<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const DEV_TAG = APP_ENV === "dev" && TOOLBAR_TOKEN && /^(https:\/\/[a-z0-9.-]+|http:\/\/localhost:\d+)\/toolbar\.js$/.test(TOOLBAR_SRC)
  ? `<script src="${attr(TOOLBAR_SRC)}" data-token="${attr(TOOLBAR_TOKEN)}" data-commit="${attr(APP_COMMIT)}" data-env="dev"></script>`
  : "";

// Dev : accès aux PAGES protégé par authentification basique (DEV_BASIC_AUTH="utilisateur:motdepasse", ASCII). Pas au niveau du proxy :
// la page envoie « Authorization: Bearer … » à ses propres appels d'API, ce qui entrerait en conflit avec une authentification basique
// posée sur tout le domaine. /healthz, /rest/ et /functions/ gardent leur propre contrôle. Sans identifiants en dev : tout est refusé.
const BASIC_EXPECTED = /^[\x20-\x7e]+:[\x20-\x7e]+$/.test(Deno.env.get("DEV_BASIC_AUTH") ?? "")
  ? "Basic " + btoa(Deno.env.get("DEV_BASIC_AUTH")!)
  : "";
async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function devAccessDenied(req: Request): Promise<Response | null> {
  if (APP_ENV !== "dev") return null;
  const deny = (status: number, msg: string) =>
    new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "WWW-Authenticate": 'Basic realm="dev", charset="UTF-8"', "X-Robots-Tag": "noindex, nofollow", ...SEC } });
  if (!BASIC_EXPECTED) return deny(503, "Dev : identifiants non configurés (DEV_BASIC_AUTH), accès fermé");
  const [a, b] = await Promise.all([sha256(req.headers.get("authorization") ?? ""), sha256(BASIC_EXPECTED)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0 ? null : deny(401, "Authentification requise");
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", png: "image/png", ico: "image/x-icon", svg: "image/svg+xml",
  json: "application/json", webmanifest: "application/manifest+json", txt: "text/plain; charset=utf-8",
};
const SEC = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
};

const text = (s: string, status: number) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...SEC } });

// --- Fichiers statiques -------------------------------------------------
async function serveStatic(pathname: string): Promise<Response> {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch (_) { return text("Requête invalide", 400); }
  if (p.includes("\0") || p.split("/").some((s) => s === "..")) return text("Introuvable", 404);
  if (p.endsWith("/")) p += "index.html";
  const rel = p.replace(/^\/+/, "");
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (!MIME[ext]) return text("Introuvable", 404);
  try {
    const file = new URL(rel, SITE);
    if (!file.pathname.startsWith(SITE.pathname)) return text("Introuvable", 404);
    if (ext === "html") {
      // La clé « anon » est publique par conception : elle est injectée à la volée, jamais écrite dans le dépôt.
      let html = (await Deno.readTextFile(file)).replaceAll("__SUPABASE_ANON_KEY__", ANON_KEY);
      // Script synchrone en tête de page : il installe ses journaux (erreurs, requêtes en échec) avant le code de la page.
      if (DEV_TAG) html = html.replace("<head>", "<head>" + DEV_TAG);
      return new Response(html, {
        headers: { "Content-Type": MIME.html, "Cache-Control": "no-cache", ...(APP_ENV === "dev" ? { "X-Robots-Tag": "noindex, nofollow" } : {}), ...SEC },
      });
    }
    const data = await Deno.readFile(file);
    return new Response(data, { headers: { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=3600", ...SEC } });
  } catch (_) {
    return text("Introuvable", 404);
  }
}

// --- Relais PostgREST ---------------------------------------------------
async function relay(req: Request, info: Deno.ServeHandlerInfo, publicFacing: boolean): Promise<Response> {
  const u = new URL(req.url);
  const headers = new Headers();
  for (const k of ["authorization", "apikey", "content-type", "prefer", "accept", "accept-profile", "content-profile"]) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  if (publicFacing) {
    // Un visiteur ne doit jamais pouvoir choisir l'adresse qui sert à limiter les essais de code :
    // cf-connecting-ip est supprimé (il n'y a pas de Cloudflare devant), x-forwarded-for vient de Traefik.
    const xff = req.headers.get("x-forwarded-for");
    const addr = info.remoteAddr as Deno.NetAddr;
    headers.set("x-forwarded-for", xff && xff.length < 500 ? xff : (addr?.hostname ?? ""));
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY) return text("Trop volumineux", 413);
  }
  try {
    const r = await fetch(POSTGREST + u.pathname.replace(/^\/rest\/v1/, "") + u.search, { method: req.method, headers, body });
    const out = new Headers(SEC);
    out.set("Content-Type", r.headers.get("content-type") ?? "application/json");
    if (!publicFacing) { const cr = r.headers.get("content-range"); if (cr) out.set("content-range", cr); }
    return new Response(r.body, { status: r.status, headers: out });
  } catch (_) {
    return text("Service indisponible", 502);
  }
}

// --- Serveur public -----------------------------------------------------
Deno.serve({ port: PORT }, async (req, info) => {
  const u = new URL(req.url);
  const p = u.pathname;
  if (p === "/healthz") return text("ok", 200);

  if (p.startsWith("/rest/v1/")) {
    // Seules les fonctions noel_* sont joignables de l'extérieur (les tables sont de toute façon fermées).
    if (req.method === "POST" && /^\/rest\/v1\/rpc\/noel_[a-z_]+$/.test(p) && !u.search) return relay(req, info, true);
    return text("Interdit", 403);
  }
  if (p === "/functions/v1/noel-preview") return preview(req);
  if (p === "/functions/v1/noel-refresh") return refresh(req);
  if (p.startsWith("/functions/")) return text("Introuvable", 404);

  if (req.method !== "GET" && req.method !== "HEAD") return text("Méthode non autorisée", 405);
  const denied = await devAccessDenied(req);
  if (denied) return denied;
  return serveStatic(p);
});

// --- Serveur interne (loopback seulement) ----------------------------------
Deno.serve({ port: INTERNAL_PORT, hostname: "127.0.0.1" }, (req, info) => {
  if (!new URL(req.url).pathname.startsWith("/rest/v1/")) return text("Introuvable", 404);
  return relay(req, info, false);
});
