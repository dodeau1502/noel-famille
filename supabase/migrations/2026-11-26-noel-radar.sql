-- 26 novembre 2026 : radar des promotions (lots A et N du guide GUIDE-RADAR-PRIX).
-- À appliquer en tant que noel_owner (voir CLAUDE.md : `set role noel_owner;` en tête, psql --single-transaction), après un pg_dump -Fc,
-- d'abord sur noel-dev-db. Puis appliquer deploy/db/03-droits.sql (droits de service_role). NE JAMAIS accorder de droit sur noel_claims à service_role.
-- Pistes de prix (radar Dealabs, Keepa, Google, e-mail). Aucune donnée de réservation (règle 1).
create table if not exists public.noel_signals (
  id          bigint generated always as identity primary key,
  gift_id     bigint not null references public.noel_gifts(id) on delete cascade,
  source      text   not null check (source in ('dealabs','keepa','google','idealo','mail')),
  ext_id      text   not null check (char_length(ext_id) <= 300),     -- guid Dealabs, ASIN+date Keepa, Message-ID…
  title       text   not null check (char_length(title) <= 200),
  merchant    text   check (char_length(merchant) <= 80),
  price       numeric check (price is null or (price > 0 and price < 100000)),
  url         text   check (url is null or (url ~ '^https://' and char_length(url) <= 500)),       -- lien marchand nettoyé
  page_url    text   check (page_url is null or (page_url ~ '^https://' and char_length(page_url) <= 500)), -- page Dealabs
  conditions  jsonb  not null default '[]'::jsonb,   -- [{type, label, code?}]
  ref30       numeric,                               -- « prix le plus bas des 30 derniers jours » annoncé
  match       text   not null check (match in ('exact','strict','loose')),
  status      text   not null default 'candidate' check (status in ('candidate','accepted','rejected','expired')),
  verified    boolean not null default false,
  verified_at timestamptz,
  page_price  numeric,                               -- prix lu sur la page du marchand s'il diffère
  seen_at     timestamptz not null,                  -- date de publication à la source
  created_at  timestamptz not null default now(),
  unique (source, ext_id, gift_id)
);
create index if not exists noel_signals_gift on public.noel_signals (gift_id, status, seen_at desc);

-- Dédoublonnage des flux : chaque guid n'est traité qu'une fois (purge au-delà de 14 jours).
create table if not exists public.noel_feed_seen (
  guid    text primary key check (char_length(guid) <= 300),
  feed    text not null,
  seen_at timestamptz not null default now()
);

-- État des sources et verrou des tâches (un seul conteneur exécute une tâche donnée à un instant).
create table if not exists public.noel_sources (
  name          text primary key,              -- 'dealabs:tous', 'dealabs:hot', 'keepa', 'mail', 'google', 'refresh'
  last_ok       timestamptz,
  last_error    text check (char_length(last_error) <= 300),
  last_error_at timestamptz,
  last_item_at  timestamptz,                   -- date du plus récent élément lu
  items_last    int,
  gaps          int not null default 0,        -- trous probables détectés
  etag          text,
  last_modified text,
  backoff_until timestamptz,
  lease_until   timestamptz,
  lease_holder  text
);

-- Compteur SerpAPI (automatique et manuel, par mois de Paris).
create table if not exists public.noel_serp_usage (
  month text not null,                         -- 'YYYY-MM'
  kind  text not null check (kind in ('auto','manual')),
  n     int  not null default 0,
  primary key (month, kind)
);

alter table public.noel_gifts add column if not exists aliases text[] not null default '{}';  -- surnoms (8 au plus, 40 caractères)
alter table public.noel_gifts add column if not exists asin text check (asin is null or asin ~ '^[A-Z0-9]{10}$');
alter table public.noel_gifts add column if not exists mpn text
  check (mpn is null or (char_length(mpn) between 4 and 40 and mpn ~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]*$'));   -- référence constructeur
alter table public.noel_gifts add column if not exists next_check_at timestamptz;                      -- prochaine relecture (lot P : calculée par noel-refresh/schedule.js, données publiques seulement)

alter table public.noel_signals    enable row level security;
alter table public.noel_feed_seen  enable row level security;
alter table public.noel_sources    enable row level security;
alter table public.noel_serp_usage enable row level security;
revoke all on public.noel_signals, public.noel_feed_seen, public.noel_sources, public.noel_serp_usage from anon, authenticated;
-- Droits de service_role : voir deploy/db/03-droits.sql. Rien sur noel_claims (règle 1).

-- Verrou d'une tâche planifiée : vrai si ce conteneur peut l'exécuter (service_role seulement).
create or replace function public.noel_job_lease(p_name text, p_seconds int, p_holder text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if coalesce(p_name, '') = '' or char_length(p_name) > 60 or coalesce(p_holder, '') = '' or char_length(p_holder) > 100 then return false; end if;
  insert into public.noel_sources(name) values (p_name) on conflict (name) do nothing;
  update public.noel_sources
     set lease_until = now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 60), 7200))), lease_holder = p_holder
   where name = p_name and (lease_until is null or lease_until < now() or lease_holder = p_holder);
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Le propriétaire accepte ou refuse une piste « à confirmer ».
create or replace function public.noel_signal_decide(p_code text, p_id bigint, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  update public.noel_signals set status = case when coalesce(p_accept, false) then 'accepted' else 'rejected' end
   where id = p_id and status = 'candidate';
  return jsonb_build_object('ok', true);
end $$;

-- Surnoms d'un cadeau (8 au plus, 2 à 40 caractères) : ils servent seulement à reconnaître les promotions.
create or replace function public.noel_set_aliases(p_code text, p_id bigint, p_aliases text[])
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); a text[];
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  select coalesce(array_agg(d.t order by d.o), '{}') into a
    from (select min(s.t) as t, min(s.o) as o
            from (select left(regexp_replace(trim(u.v), '\s+', ' ', 'g'), 40) as t, u.o
                    from unnest(coalesce(p_aliases, '{}')) with ordinality as u(v, o)) s
           where char_length(s.t) >= 2 group by lower(s.t)) d;
  if coalesce(array_length(a, 1), 0) > 8 then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts set aliases = a where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Référence Amazon (ASIN) saisie à la main ; null ou vide pour l'effacer.
create or replace function public.noel_set_asin(p_code text, p_id bigint, p_asin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); a text := upper(trim(coalesce(p_asin, '')));
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if a <> '' and a !~ '^[A-Z0-9]{10}$' then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts set asin = nullif(a, '') where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Référence constructeur (MPN) saisie à la main ; vide pour l'effacer.
create or replace function public.noel_set_mpn(p_code text, p_id bigint, p_mpn text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); m text := trim(coalesce(p_mpn, ''));
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if m <> '' and (char_length(m) not between 4 and 40 or m !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]*$') then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts set mpn = nullif(m, '') where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- État des sources et pistes « à confirmer » (propriétaire seulement). Aucune donnée de réservation.
create or replace function public.noel_status(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); mo text := to_char(now() at time zone 'Europe/Paris', 'YYYY-MM');
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  return jsonb_build_object(
    'sources', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'last_ok', s.last_ok, 'last_error', s.last_error, 'last_error_at', s.last_error_at,
                          'last_item_at', s.last_item_at, 'items_last', s.items_last, 'gaps', s.gaps, 'backoff_until', s.backoff_until) order by s.name)
                           from public.noel_sources s), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'gift_id', c.gift_id, 'gift', g.title, 'source', c.source, 'title', c.title, 'merchant', c.merchant,
                          'price', c.price, 'url', c.url, 'page_url', c.page_url, 'conditions', c.conditions, 'seen_at', c.seen_at) order by c.seen_at desc)
                           from (select * from public.noel_signals where status = 'candidate' order by seen_at desc limit 50) c
                           join public.noel_gifts g on g.id = c.gift_id), '[]'::jsonb),
    'serp', jsonb_build_object('month', mo,
                               'auto', coalesce((select n from public.noel_serp_usage where month = mo and kind = 'auto'), 0),
                               'manual', coalesce((select n from public.noel_serp_usage where month = mo and kind = 'manual'), 0)));
end $$;

-- Nettoyage quotidien (service_role seulement, appelé par le planificateur du serveur).
create or replace function public.noel_radar_purge()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.noel_feed_seen where seen_at < now() - interval '14 days';
  update public.noel_signals set status = 'expired' where status = 'candidate' and created_at < now() - interval '7 days';
  delete from public.noel_signals where status in ('rejected', 'expired') and created_at < now() - interval '60 days';
  return jsonb_build_object('ok', true);
end $$;

-- noel_get / noel_public : ajoutent aliases, asin, mpn et signals (identiques pour tous les rôles)
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
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    || case when r = 'owner' then '{}'::jsonb
            else jsonb_build_object('claimed_by', c.claimed_by, 'bought', coalesce(c.bought, false), 'paid', c.paid) end
    order by g.created_at), '[]'::jsonb)
  into res
  from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id;
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
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    order by g.created_at), '[]'::jsonb)
  into res from public.noel_gifts g;
  return jsonb_build_object('role', 'public', 'title', t, 'gifts', res, 'display', jsonb_build_object('featured', f, 'mode', m));
end $$;


revoke all on function public.noel_signal_decide(text,bigint,boolean), public.noel_set_aliases(text,bigint,text[]), public.noel_set_asin(text,bigint,text),
  public.noel_set_mpn(text,bigint,text), public.noel_status(text) from public;
grant execute on function public.noel_signal_decide(text,bigint,boolean), public.noel_set_aliases(text,bigint,text[]), public.noel_set_asin(text,bigint,text),
  public.noel_set_mpn(text,bigint,text), public.noel_status(text) to anon, authenticated;
-- Jamais appelables depuis l'API publique : réservées à service_role (droits accordés dans deploy/db/03-droits.sql)
revoke all on function public.noel_job_lease(text,int,text), public.noel_radar_purge() from public, anon, authenticated;
