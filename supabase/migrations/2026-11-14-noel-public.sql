-- Accès public en lecture seule (14 novembre) : la famille ouvre le site sans code.
-- Ne renvoie AUCUNE donnée de réservation (claimed_by, bought, paid) ni donnée propriétaire (blocked).
-- Les fonctions d'écriture restent protégées par le code propriétaire.
create or replace function public.noel_public()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare t text; f jsonb; m text; res jsonb;
begin
  select title, featured, order_mode into t, f, m from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                       'image', g.image_url, 'price', g.price, 'store', g.store,
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top,
                       'gtin', g.gtin, 'checked_at', g.checked_at, 'pinned', to_jsonb(g.pinned), 'variant', g.variant, 'category', g.category, 'cmp', g.cmp,
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    order by g.created_at), '[]'::jsonb)
  into res from public.noel_gifts g;
  return jsonb_build_object('role', 'public', 'title', t, 'gifts', res, 'display', jsonb_build_object('featured', f, 'mode', m));
end $$;
revoke all on function public.noel_public() from public;
grant execute on function public.noel_public() to anon, authenticated;
