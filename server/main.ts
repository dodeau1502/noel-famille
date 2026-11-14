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
      const html = (await Deno.readTextFile(file)).replaceAll("__SUPABASE_ANON_KEY__", ANON_KEY);
      return new Response(html, { headers: { "Content-Type": MIME.html, "Cache-Control": "no-cache", ...SEC } });
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
  return serveStatic(p);
});

// --- Serveur interne (loopback seulement) ----------------------------------
Deno.serve({ port: INTERNAL_PORT, hostname: "127.0.0.1" }, (req, info) => {
  if (!new URL(req.url).pathname.startsWith("/rest/v1/")) return text("Introuvable", 404);
  return relay(req, info, false);
});
