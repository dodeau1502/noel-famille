// Accès à la base par PostgREST avec la clé de service (rôle service_role). Tables autorisées : voir deploy/db/03-droits.sql.
// Jamais noel_claims (règle 1). Le `fetch` est lu à chaque appel : les tests peuvent le remplacer.
function cfg() {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, ""), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { url, h: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } as Record<string, string> };
}
async function call(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
  const { url, h } = cfg();
  const headers = prefer ? { ...h, Prefer: prefer } : h;
  const r = await fetch(`${url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`base ${method} ${path.split("?")[0]} : ${r.status}`);
  try { return t ? JSON.parse(t) : null; } catch (_) { return null; }
}
export const dbGet = (path: string): Promise<any[]> => call("GET", path).then((x) => (Array.isArray(x) ? x : []));
export const dbPost = (path: string, body: unknown, prefer = "return=minimal") => call("POST", path, body, prefer);
export const dbPatch = (path: string, body: unknown) => call("PATCH", path, body, "return=minimal");
export const rpc = (name: string, body: unknown) => call("POST", `rpc/${name}`, body);
export const enc = encodeURIComponent;

// État d'une source (table noel_sources)
export async function getSource(name: string): Promise<Record<string, any>> {
  return (await dbGet(`noel_sources?name=eq.${enc(name)}&select=*&limit=1`))[0] ?? { name };
}
export async function touchSource(name: string, patch: Record<string, unknown>) {
  await dbPost("noel_sources?on_conflict=name", [{ name, ...patch }], "resolution=merge-duplicates,return=minimal");
}
