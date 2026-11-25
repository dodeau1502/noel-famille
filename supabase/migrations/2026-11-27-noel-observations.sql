-- 27 novembre 2026 : relevé de prix par marchand (lot O du guide GUIDE-RADAR-PRIX).
-- À appliquer en tant que noel_owner (`set role noel_owner;`, psql --single-transaction), après un pg_dump -Fc, d'abord sur noel-dev-db.
-- Puis appliquer deploy/db/03-droits.sql (droits de service_role). Rien sur noel_claims.

-- Un relevé de prix par marchand (lot O). Identique pour tous : aucun lien avec les réservations (règle 1).
create table if not exists public.noel_observations (
  id        bigint generated always as identity primary key,
  gift_id   bigint not null references public.noel_gifts(id) on delete cascade,
  mkey      text not null check (char_length(mkey) between 1 and 60),   -- nom du marchand normalisé (observe.js : mkeyOf)
  merchant  text not null check (char_length(merchant) <= 80),
  price     numeric not null check (price > 0 and price < 100000),
  shipping  numeric check (shipping is null or shipping >= 0),
  total     numeric not null check (total > 0),
  stock     text check (stock in ('in','out','pre','')),
  verified  boolean not null,                                          -- lu sur la page du marchand
  method    text not null check (method in ('page','google','dealabs','keepa','manual','mail')),
  at        timestamptz not null default now()
);
create index if not exists noel_observations_gift on public.noel_observations (gift_id, mkey, at desc);

alter table public.noel_observations enable row level security;
revoke all on public.noel_observations from anon, authenticated;

create or replace function public.noel_radar_purge()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.noel_feed_seen where seen_at < now() - interval '14 days';
  delete from public.noel_observations where at < now() - interval '180 days';
  update public.noel_signals set status = 'expired' where status = 'candidate' and created_at < now() - interval '7 days';
  delete from public.noel_signals where status in ('rejected', 'expired') and created_at < now() - interval '60 days';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_get(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); t text; f jsonb; m text; res jsonb;
begin
  if r is null or r = 'throttled' then return public.noel_deny(r); end if;
  select title, featured, order_mode into t, f, m from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                       'image', g.image_url, 'price', g.price, 'store', g.store,
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top, 'rank', g.rank,
                       'gtin', g.gtin, 'checked_at', g.checked_at, 'pinned', to_jsonb(g.pinned), 'variant', g.variant, 'category', g.category, 'cmp', g.cmp, 'with', g.with_id,
                       'aliases', to_jsonb(g.aliases), 'asin', g.asin, 'mpn', g.mpn,
                       -- Pistes de prix : MÊMES champs pour tous les rôles (aucun lien avec les réservations)
                       'signals', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source, 'title', s.title, 'merchant', s.merchant, 'price', s.price,
                                              'url', s.url, 'page_url', s.page_url, 'conditions', s.conditions, 'ref30', s.ref30, 'verified', s.verified,
                                              'verified_at', s.verified_at, 'page_price', s.page_price, 'seen_at', s.seen_at) order by s.price nulls last, s.seen_at desc)
                                              from (select * from public.noel_signals x where x.gift_id = g.id and x.status = 'accepted'
                                                      and (x.seen_at > now() - interval '72 hours' or x.verified_at > now() - interval '24 hours')
                                                    order by x.price nulls last, x.seen_at desc limit 5) s), '[]'::jsonb),
                       -- Plus bas relevé vérifié par marchand sur 30 jours (lot O) : mêmes champs pour tous
                       'low30', coalesce((select jsonb_agg(jsonb_build_object('mkey', l.mkey, 'total', l.total, 'at', l.at))
                                              from (select distinct on (x.mkey) x.mkey, x.total, x.at from public.noel_observations x
                                                    where x.gift_id = g.id and x.verified and x.at > now() - interval '30 days'
                                                    order by x.mkey, x.total, x.at desc) l), '[]'::jsonb),
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
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top, 'rank', g.rank,
                       'gtin', g.gtin, 'checked_at', g.checked_at, 'pinned', to_jsonb(g.pinned), 'variant', g.variant, 'category', g.category, 'cmp', g.cmp, 'with', g.with_id,
                       'aliases', to_jsonb(g.aliases), 'asin', g.asin, 'mpn', g.mpn,
                       -- Pistes de prix : MÊMES champs pour tous les rôles (aucun lien avec les réservations)
                       'signals', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source, 'title', s.title, 'merchant', s.merchant, 'price', s.price,
                                              'url', s.url, 'page_url', s.page_url, 'conditions', s.conditions, 'ref30', s.ref30, 'verified', s.verified,
                                              'verified_at', s.verified_at, 'page_price', s.page_price, 'seen_at', s.seen_at) order by s.price nulls last, s.seen_at desc)
                                              from (select * from public.noel_signals x where x.gift_id = g.id and x.status = 'accepted'
                                                      and (x.seen_at > now() - interval '72 hours' or x.verified_at > now() - interval '24 hours')
                                                    order by x.price nulls last, x.seen_at desc limit 5) s), '[]'::jsonb),
                       -- Plus bas relevé vérifié par marchand sur 30 jours (lot O) : mêmes champs pour tous
                       'low30', coalesce((select jsonb_agg(jsonb_build_object('mkey', l.mkey, 'total', l.total, 'at', l.at))
                                              from (select distinct on (x.mkey) x.mkey, x.total, x.at from public.noel_observations x
                                                    where x.gift_id = g.id and x.verified and x.at > now() - interval '30 days'
                                                    order by x.mkey, x.total, x.at desc) l), '[]'::jsonb),
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    order by g.created_at), '[]'::jsonb)
  into res from public.noel_gifts g;
  return jsonb_build_object('role', 'public', 'title', t, 'gifts', res, 'display', jsonb_build_object('featured', f, 'mode', m));
end $$;

-- Les fonctions remplacées gardent leurs droits d'exécution ; noel_radar_purge reste réservée à service_role.
