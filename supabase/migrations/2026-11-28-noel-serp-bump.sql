-- 28 novembre 2026 : compteur SerpAPI atomique (lot I du guide GUIDE-RADAR-PRIX).
-- À appliquer en tant que noel_owner (set role noel_owner; psql --single-transaction), d'abord sur noel-dev-db. Puis deploy/db/03-droits.sql.
-- Compteur SerpAPI atomique (service_role seulement). p_cap : plafond du mois pour ce type (balayage automatique) ; null = pas de plafond (actions manuelles).
create or replace function public.noel_serp_bump(p_kind text, p_cap int default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare mo text := to_char(now() at time zone 'Europe/Paris', 'YYYY-MM'); v int;
begin
  if p_kind not in ('auto', 'manual') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  insert into public.noel_serp_usage(month, kind, n) values (mo, p_kind, 0) on conflict (month, kind) do nothing;
  update public.noel_serp_usage set n = n + 1 where month = mo and kind = p_kind and (p_cap is null or n < p_cap) returning n into v;
  if v is null then return jsonb_build_object('ok', false, 'error', 'cap'); end if;
  return jsonb_build_object('ok', true, 'n', v);
end $$;

revoke all on function public.noel_serp_bump(text,int) from public, anon, authenticated;
