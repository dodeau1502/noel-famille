-- 15 novembre : cadeau relié (« Va avec »)
alter table public.noel_gifts add column if not exists with_id bigint references public.noel_gifts(id) on delete set null;
create or replace function public.noel_get(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); t text; f jsonb; m text; res jsonb;
begin
  if r is null or r = 'throttled' then return public.noel_deny(r); end if;
  select title, featured, order_mode into t, f, m from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                       'image', g.image_url, 'price', g.price, 'store', g.store,
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top,
                       'gtin', g.gtin, 'checked_at', g.checked_at, 'pinned', to_jsonb(g.pinned), 'variant', g.variant, 'category', g.category, 'cmp', g.cmp, 'with', g.with_id,
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    || case when r = 'owner' then '{}'::jsonb
            else jsonb_build_object('claimed_by', c.claimed_by, 'bought', coalesce(c.bought, false), 'paid', c.paid) end
    order by g.created_at), '[]'::jsonb)
  into res
  from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id;
  -- Le propriétaire reçoit en plus la liste des marchands qu'il a écartés (aucune donnée de réservation).
  return jsonb_build_object('role', r, 'title', t, 'gifts', res, 'display', jsonb_build_object('featured', f, 'mode', m))
    || case when r = 'owner'
            then jsonb_build_object('blocked', (select coalesce(jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label) order by b.at), '[]'::jsonb) from public.noel_blocked b))
            else '{}'::jsonb end;
end $$;

create or replace function public.noel_public()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare t text; f jsonb; m text; res jsonb;
begin
  select title, featured, order_mode into t, f, m from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                       'image', g.image_url, 'price', g.price, 'store', g.store,
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top,
                       'gtin', g.gtin, 'checked_at', g.checked_at, 'pinned', to_jsonb(g.pinned), 'variant', g.variant, 'category', g.category, 'cmp', g.cmp, 'with', g.with_id,
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    order by g.created_at), '[]'::jsonb)
  into res from public.noel_gifts g;
  return jsonb_build_object('role', 'public', 'title', t, 'gifts', res, 'display', jsonb_build_object('featured', f, 'mode', m));
end $$;

-- Cadeau relié (« Va avec ») : propriétaire seulement, public, aucun lien avec les réservations
create or replace function public.noel_set_with(p_code text, p_id bigint, p_with bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_with is not null and (p_with = p_id or not exists (select 1 from public.noel_gifts where id = p_with)) then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts set with_id = p_with where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.noel_set_with(text,bigint,bigint) from public;
grant execute on function public.noel_set_with(text,bigint,bigint) to anon, authenticated;
