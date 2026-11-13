// Génère les deux clés JWT (HS256) pour PostgREST à partir de JWT_SECRET.
// Usage sur le VPS :  read -rs JWT_SECRET; export JWT_SECRET; node deploy/creer-cles.mjs
// Les clés s'affichent une fois : à copier dans les variables Coolify (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).
import { createHmac } from "node:crypto";
const secret = process.env.JWT_SECRET ?? "";
if (secret.length < 32) { console.error("JWT_SECRET manquant ou trop court (32 caractères minimum)."); process.exit(1); }
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (role) => {
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role, iat: Math.floor(Date.now() / 1000) });
  return `${h}.${p}.` + createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
};
console.log("SUPABASE_ANON_KEY=" + sign("anon"));
console.log("SUPABASE_SERVICE_ROLE_KEY=" + sign("service_role"));
