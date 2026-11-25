-- Liste de Noël famille : état actuel complet de la base (v5)
-- Les tables ne sont lisibles par personne via l'API ; tout passe par des fonctions
-- qui vérifient un code (propriétaire ou famille). Le propriétaire ne reçoit
-- jamais les informations de réservation (claimed_by, bought, paid).
-- Convention : les fonctions API renvoient du jsonb {"ok":true} ou {"error":"denied|throttled|taken|short|same_as_owner|empty|invalid"}
-- au lieu de lever une exception (sinon l'enregistrement des essais ratés serait annulé).

create extension if not exists pgcrypto with schema extensions;

create table public.noel_config (
  id int primary key default 1 check (id = 1),
  title text not null default 'Ma liste de Noël',
  owner_hash text not null,
  family_hash text not null,
  featured jsonb not null default '[]'::jsonb,                 -- sites mis en avant par le propriétaire : [{key,label}]
  order_mode text not null default 'price' check (order_mode in ('price', 'featured'))   -- ordre des prix proposé par défaut
);

create table public.noel_gifts (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 120),
  url text check (url is null or char_length(url) <= 500),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  image_url text,
  price numeric,
  store text,
  offers jsonb,
  offers_at timestamptz,
  top boolean not null default false,
  rank int check (rank is null or rank between 1 and 1000),   -- classement choisi par le propriétaire (1 = en premier), identique pour tous
  gtin text check (gtin is null or gtin ~ '^[0-9]{8,14}$'),   -- code-barres lu sur la page collée
  checked_at timestamptz,                                      -- dernière relecture des pages des marchands
  pinned text[] not null default '{}',                         -- sites mis en avant sur cette fiche (clés de nom normalisées, 3 au plus)
  variant text,                                                -- version souhaitée (120 caractères au plus)
  category text,                                               -- catégorie libre (30 caractères au plus)
  cmp jsonb,                                                   -- liens de fiche {idealo, denicheur}, https, saisis à la main
  with_id bigint references public.noel_gifts(id) on delete set null -- cadeau relié : va avec un autre cadeau (aucun lien avec les réservations)
);

create table public.noel_claims (
  gift_id bigint primary key references public.noel_gifts(id) on delete cascade,
  claimed_by text not null check (char_length(claimed_by) between 1 and 40),
  claimed_at timestamptz not null default now(),
  bought boolean not null default false,
  paid numeric check (paid is null or (paid > 0 and paid < 100000))   -- prix payé, saisi par la famille, jamais renvoyé au propriétaire
);

-- Historique des prix : meilleur prix (livraison comprise si connue), au plus un point par jour ou à chaque changement.
-- Alimenté par noel_add, noel_set_offers et la fonction noel-refresh. Identique pour tous : aucun lien avec les réservations.
create table public.noel_prices (
  id bigint generated always as identity primary key,
  gift_id bigint not null references public.noel_gifts(id) on delete cascade,
  price numeric not null check (price > 0),
  store text,
  verified boolean not null default false,   -- prix lu sur la page du marchand
  at timestamptz not null default now()
);
create index noel_prices_gift_at on public.noel_prices (gift_id, at);

-- Un relevé de prix par marchand (lot O). Identique pour tous : aucun lien avec les réservations (règle 1).
create table public.noel_observations (
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
create index noel_observations_gift on public.noel_observations (gift_id, mkey, at desc);

-- Sécurité des marchands. Liste noire du propriétaire (nom normalisé + domaine) et cache de l'âge des domaines (RDAP, 30 jours).
-- Aucun lien avec les réservations. Lus uniquement par la fonction noel-preview (clé de service).
create table public.noel_blocked (
  key   text primary key,
  host  text,
  label text not null,
  at    timestamptz not null default now()
);
create table public.noel_domains (
  domain     text primary key,
  created    timestamptz,
  checked_at timestamptz not null default now()
);

-- Essais de code ratés, pour limiter les devinettes (15 par 10 minutes et par adresse)
create table public.noel_attempts (
  ip text not null,
  at timestamptz not null default now()
);
create index noel_attempts_ip_at on public.noel_attempts (ip, at);

alter table public.noel_config   enable row level security;
alter table public.noel_gifts    enable row level security;
alter table public.noel_claims   enable row level security;
alter table public.noel_attempts enable row level security;
alter table public.noel_prices   enable row level security;
alter table public.noel_blocked  enable row level security;
alter table public.noel_domains  enable row level security;
-- Aucune policy : aucun accès direct via l'API publique.
revoke all on public.noel_config, public.noel_gifts, public.noel_claims, public.noel_attempts, public.noel_prices, public.noel_blocked, public.noel_domains from anon, authenticated;

create or replace function public.noel_client_ip()
returns text language sql stable set search_path = public as $$
  select coalesce(
    nullif(nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip', ''),
    nullif(trim(regexp_replace(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), '^.*,', '')), ''),
    'inconnu')
$$;

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

alter table public.noel_observations enable row level security;
revoke all on public.noel_observations from anon, authenticated;
alter table public.noel_signals    enable row level security;
alter table public.noel_feed_seen  enable row level security;
alter table public.noel_sources    enable row level security;
alter table public.noel_serp_usage enable row level security;
revoke all on public.noel_signals, public.noel_feed_seen, public.noel_sources, public.noel_serp_usage from anon, authenticated;

create or replace function public.noel_deny(r text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('error', case when r = 'throttled' then 'throttled' else 'denied' end)
$$;

create or replace function public.noel_role(p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare c public.noel_config; v_ip text := public.noel_client_ip(); n int; v text := coalesce(p_code, '');
begin
  select count(*) into n from public.noel_attempts a where a.ip = v_ip and a.at > now() - interval '10 minutes';
  if n >= 15 then return 'throttled'; end if;
  select * into c from public.noel_config where id = 1;
  if v <> '' and c.owner_hash = crypt(v, c.owner_hash) then return 'owner'; end if;
  if v <> '' and c.family_hash = crypt(v, c.family_hash) then return 'family'; end if;
  insert into public.noel_attempts(ip) values (v_ip);
  delete from public.noel_attempts where at < now() - interval '1 day';
  return null;
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

-- Accès public en lecture seule : aucune donnée de réservation, aucun code requis (14 novembre).
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

create or replace function public.noel_add(p_code text, p_title text, p_url text, p_note text, p_image text,
                                           p_price numeric, p_store text, p_offers jsonb, p_top boolean, p_gtin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); v_id bigint; v_has boolean;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  v_has := p_offers is not null and jsonb_typeof(p_offers) = 'array' and jsonb_array_length(p_offers) > 0;
  insert into public.noel_gifts(title, url, note, image_url, price, store, offers, offers_at, checked_at, top, gtin)
  values (trim(p_title), nullif(trim(p_url), ''), nullif(trim(p_note), ''),
          nullif(trim(p_image), ''), p_price, nullif(trim(p_store), ''),
          case when v_has then p_offers end,
          case when v_has then now() end,
          case when v_has then now() end,
          coalesce(p_top, false),
          case when p_gtin ~ '^[0-9]{8,14}$' then p_gtin end)
  returning id into v_id;
  if p_price is not null and p_price > 0 then
    insert into public.noel_prices(gift_id, price, store, verified) values (v_id, p_price, nullif(trim(p_store), ''), false);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_remove(p_code text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  delete from public.noel_gifts where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_set_top(p_code text, p_id bigint, p_top boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  update public.noel_gifts set top = coalesce(p_top, false) where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Enregistre tout le classement d'un coup : la liste d'identifiants, dans l'ordre (1er, 2e…). Les autres cadeaux n'ont plus de rang.
create or replace function public.noel_set_rank(p_code text, p_ids bigint[])
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_ids is null then p_ids := '{}'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 1000 or (select count(distinct x) from unnest(p_ids) x) <> coalesce(array_length(p_ids, 1), 0) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.noel_gifts set rank = null where rank is not null;
  update public.noel_gifts g set rank = o.n from unnest(p_ids) with ordinality as o(id, n) where g.id = o.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_set_offers(p_code text, p_id bigint, p_price numeric, p_store text, p_offers jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_offers is null or jsonb_typeof(p_offers) <> 'array' or jsonb_array_length(p_offers) = 0 then
    return jsonb_build_object('error', 'empty');
  end if;
  update public.noel_gifts
     set price = p_price, store = nullif(trim(p_store), ''), offers = p_offers, offers_at = now(), checked_at = now()
   where id = p_id;
  if found and p_price is not null and p_price > 0 then
    insert into public.noel_prices(gift_id, price, store, verified) values (p_id, p_price, nullif(trim(p_store), ''), false);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_set_family_code(p_code text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_new is null or char_length(p_new) < 12 or char_length(p_new) > 100 then return jsonb_build_object('error', 'short'); end if;
  if crypt(p_new, (select owner_hash from public.noel_config where id = 1)) = (select owner_hash from public.noel_config where id = 1) then
    return jsonb_build_object('error', 'same_as_owner');
  end if;
  update public.noel_config set family_hash = crypt(p_new, gen_salt('bf')) where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_claim(p_code text, p_id bigint, p_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'family' then return public.noel_deny(r); end if;
  insert into public.noel_claims(gift_id, claimed_by) values (p_id, trim(p_name));
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('error', 'taken');
end $$;

create or replace function public.noel_unclaim(p_code text, p_id bigint, p_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'family' then return public.noel_deny(r); end if;
  delete from public.noel_claims where gift_id = p_id and lower(claimed_by) = lower(trim(p_name));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_set_bought(p_code text, p_id bigint, p_name text, p_bought boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'family' then return public.noel_deny(r); end if;
  update public.noel_claims set bought = coalesce(p_bought, false)
   where gift_id = p_id and lower(claimed_by) = lower(trim(p_name));
  return jsonb_build_object('ok', true);
end $$;

-- Prix payé : enregistré par la famille sur le cadeau qu'elle a pris. Jamais renvoyé au propriétaire (voir noel_get).
create or replace function public.noel_set_paid(p_code text, p_id bigint, p_name text, p_paid numeric)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'family' then return public.noel_deny(r); end if;
  if p_paid is not null and (p_paid <= 0 or p_paid >= 100000) then return jsonb_build_object('error', 'empty'); end if;
  update public.noel_claims set paid = p_paid
   where gift_id = p_id and lower(claimed_by) = lower(trim(p_name));
  return jsonb_build_object('ok', true);
end $$;

-- Modification manuelle (propriétaire) : fiche, offres, sites en avant.
create or replace function public.noel_update_gift(p_code text, p_id bigint, p_title text, p_url text, p_note text, p_image text, p_gtin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); t text := trim(coalesce(p_title, '')); u text := nullif(trim(coalesce(p_url, '')), '');
        n text := nullif(trim(coalesce(p_note, '')), ''); i text := nullif(trim(coalesce(p_image, '')), '');
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if char_length(t) < 1 or char_length(t) > 120 then return jsonb_build_object('error', 'empty'); end if;
  if u is not null and (u !~* '^https?://' or char_length(u) > 500) then return jsonb_build_object('error', 'invalid'); end if;
  if n is not null and char_length(n) > 500 then return jsonb_build_object('error', 'invalid'); end if;
  if i is not null and (i !~* '^https://' or char_length(i) > 1000) then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts
     set title = t, url = u, note = n, image_url = i,
         gtin = case when trim(coalesce(p_gtin, '')) ~ '^[0-9]{8,14}$' then trim(p_gtin) end
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Modification manuelle des offres d'une fiche (ajout, correction, retrait). Le prix et le marchand de la fiche sont recalculés.
create or replace function public.noel_edit_offers(p_code text, p_id bigint, p_offers jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  r text := public.noel_role(p_code); o jsonb; clean jsonb := '[]'::jsonb; bad boolean;
  bs text; bp numeric; bv boolean := false; l record;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_offers is null or jsonb_typeof(p_offers) <> 'array' or jsonb_array_length(p_offers) > 12 then return jsonb_build_object('error', 'invalid'); end if;
  for o in select * from jsonb_array_elements(p_offers) loop
    bad := jsonb_typeof(o) <> 'object'
       or char_length(trim(coalesce(o->>'store', ''))) not between 1 and 60
       or case when coalesce(o->>'price', '') ~ '^[0-9]{1,5}(\.[0-9]{1,2})?$' then (o->>'price')::numeric <= 0 else true end
       or coalesce(o->>'url', '') !~* '^https://' or char_length(o->>'url') > 500
       or (o->>'shipping' is not null and o->>'shipping' !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$');
    if bad then return jsonb_build_object('error', 'invalid'); end if;
    clean := clean || jsonb_build_array(jsonb_build_object(
      'store', trim(o->>'store'), 'price', (o->>'price')::numeric, 'url', o->>'url',
      'shipping', case when o->>'shipping' is not null then (o->>'shipping')::numeric end,
      'verified', coalesce(o->>'verified', '') = 'true',
      'at', case when coalesce(o->>'at', '') ~ '^[0-9T:.+Z-]{10,40}$' then o->>'at' end,
      'stock', case when o->>'stock' in ('in', 'out', 'pre') then o->>'stock' else '' end,
      'via', case when o->>'via' in ('google', 'page', 'manual') then o->>'via' else '' end,
      'trust', case when jsonb_typeof(o->'trust') = 'object' then o->'trust' end));
  end loop;
  select x->>'store', (x->>'price')::numeric + coalesce((x->>'shipping')::numeric, 0), (x->>'verified')::boolean into bs, bp, bv
    from jsonb_array_elements(clean) x where x->>'stock' <> 'out'
   order by (coalesce(x->'trust'->>'l', '') = 'caution'), (x->>'price')::numeric + coalesce((x->>'shipping')::numeric, 0) limit 1;
  update public.noel_gifts
     set offers = case when jsonb_array_length(clean) = 0 then null else clean end,
         offers_at = case when jsonb_array_length(clean) = 0 then null else now() end,
         price = bp, store = bs
   where id = p_id;
  if found and bp is not null then
    select price, at into l from public.noel_prices where gift_id = p_id order by at desc limit 1;
    if l.price is null or l.price <> bp or l.at < now() - interval '20 hours' then
      insert into public.noel_prices(gift_id, price, store, verified) values (p_id, bp, bs, coalesce(bv, false));
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Sites mis en avant sur une fiche (3 au plus, clés de nom normalisées)
-- Version souhaitée, catégorie et liens de fiche idealo / Le Dénicheur (propriétaire seulement ; aucun lien avec les réservations)
create or replace function public.noel_set_extras(p_code text, p_id bigint, p_variant text, p_category text, p_idealo text, p_denicheur text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); v text := nullif(trim(coalesce(p_variant, '')), ''); c text := nullif(trim(coalesce(p_category, '')), '');
        i text := nullif(trim(coalesce(p_idealo, '')), ''); d text := nullif(trim(coalesce(p_denicheur, '')), ''); cm jsonb := '{}'::jsonb;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if v is not null and char_length(v) > 120 then return jsonb_build_object('error', 'invalid'); end if;
  if c is not null and char_length(c) > 30 then return jsonb_build_object('error', 'invalid'); end if;
  if i is not null and (char_length(i) > 500 or i !~* '^https://(www\.)?idealo\.[a-z]{2,3}/') then return jsonb_build_object('error', 'invalid'); end if;
  if d is not null and (char_length(d) > 500 or d !~* '^https://(www\.)?ledenicheur\.fr/') then return jsonb_build_object('error', 'invalid'); end if;
  if i is not null then cm := cm || jsonb_build_object('idealo', i); end if;
  if d is not null then cm := cm || jsonb_build_object('denicheur', d); end if;
  update public.noel_gifts set variant = v, category = c, cmp = case when cm = '{}'::jsonb then null else cm end where id = p_id;
  return jsonb_build_object('ok', true);
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

create or replace function public.noel_set_pinned(p_code text, p_id bigint, p_keys text[])
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); k text; ks text[] := '{}';
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  foreach k in array coalesce(p_keys, '{}') loop
    if k !~ '^[a-z0-9]{1,60}$' then return jsonb_build_object('error', 'invalid'); end if;
    if not (k = any(ks)) then ks := ks || k; end if;
  end loop;
  if coalesce(array_length(ks, 1), 0) > 3 then return jsonb_build_object('error', 'invalid'); end if;
  update public.noel_gifts set pinned = ks where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Affichage commun à toute la famille : sites favoris du propriétaire et ordre par défaut (« price » ou « featured »)
create or replace function public.noel_set_display(p_code text, p_featured jsonb, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); f jsonb := '[]'::jsonb; x jsonb; k text;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if p_mode is null or p_mode not in ('price', 'featured') then return jsonb_build_object('error', 'invalid'); end if;
  if p_featured is null or jsonb_typeof(p_featured) <> 'array' or jsonb_array_length(p_featured) > 10 then return jsonb_build_object('error', 'invalid'); end if;
  for x in select * from jsonb_array_elements(p_featured) loop
    k := public.noel_key(x->>'label');
    if jsonb_typeof(x) <> 'object' or k = '' or char_length(x->>'label') > 60 then return jsonb_build_object('error', 'invalid'); end if;
    f := f || jsonb_build_array(jsonb_build_object('key', k, 'label', trim(x->>'label')));
  end loop;
  update public.noel_config set featured = f, order_mode = p_mode where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Sécurité des marchands : le propriétaire écarte un marchand (par nom normalisé et domaine) ; il disparaît des offres déjà enregistrées
-- (toutes les fiches, de la même façon) et n'est plus proposé. Ne touche jamais aux réservations.
create or replace function public.noel_key(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(translate(lower(coalesce(p, '')), 'àâäáãåéèêëíìîïóòôöõúùûüýÿçñ', 'aaaaaaeeeeiiiiooooouuuuyycn'), '[^a-z0-9]', '', 'g')
$$;

create or replace function public.noel_block_merchant(p_code text, p_name text, p_host text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  r text := public.noel_role(p_code);
  k text := public.noel_key(p_name);
  h text := lower(coalesce(nullif(trim(p_host), ''), ''));
  g record; nv jsonb; bs text; bp numeric;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  if k = '' then return jsonb_build_object('error', 'empty'); end if;
  if h !~ '^[a-z0-9.-]{0,100}$' or h like 'www.google.%' then h := ''; end if;
  h := regexp_replace(h, '^www\.', '');
  insert into public.noel_blocked(key, host, label) values (k, nullif(h, ''), left(trim(p_name), 60))
  on conflict (key) do update set host = coalesce(excluded.host, public.noel_blocked.host);
  -- Retire ce marchand des offres déjà enregistrées (toutes les fiches, de la même façon)
  for g in select id, offers from public.noel_gifts where offers is not null and jsonb_typeof(offers) = 'array' loop
    select coalesce(jsonb_agg(o), '[]'::jsonb) into nv from jsonb_array_elements(g.offers) o
     where not (public.noel_key(o->>'store') = k
                or (h <> '' and regexp_replace(coalesce(substring(o->>'url' from '^https?://([^/:?#]+)'), ''), '^www\.', '') ~ ('(^|\.)' || replace(h, '.', '\.') || '$')));
    if jsonb_array_length(nv) <> jsonb_array_length(g.offers) then
      bs := null; bp := null;
      select o->>'store', (o->>'price')::numeric + coalesce((o->>'shipping')::numeric, 0) into bs, bp
        from jsonb_array_elements(nv) o where coalesce(o->>'stock', '') <> 'out'
        order by (o->>'price')::numeric + coalesce((o->>'shipping')::numeric, 0) limit 1;
      update public.noel_gifts
         set offers = case when jsonb_array_length(nv) = 0 then null else nv end, price = bp, store = bs
       where id = g.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_unblock_merchant(p_code text, p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  delete from public.noel_blocked where key = p_key;
  return jsonb_build_object('ok', true);
end $$;

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
  delete from public.noel_observations where at < now() - interval '180 days';
  update public.noel_signals set status = 'expired' where status = 'candidate' and created_at < now() - interval '7 days';
  delete from public.noel_signals where status in ('rejected', 'expired') and created_at < now() - interval '60 days';
  return jsonb_build_object('ok', true);
end $$;

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

-- Fonctions internes : jamais appelables depuis l'API publique
revoke all on function public.noel_role(text), public.noel_deny(text), public.noel_client_ip() from public, anon, authenticated;

-- Fonctions de l'API
revoke all on function
  public.noel_get(text),
  public.noel_add(text,text,text,text,text,numeric,text,jsonb,boolean,text),
  public.noel_remove(text,bigint),
  public.noel_set_top(text,bigint,boolean),
  public.noel_set_offers(text,bigint,numeric,text,jsonb),
  public.noel_set_family_code(text,text),
  public.noel_claim(text,bigint,text),
  public.noel_unclaim(text,bigint,text),
  public.noel_set_bought(text,bigint,text,boolean),
  public.noel_set_paid(text,bigint,text,numeric),
  public.noel_block_merchant(text,text,text),
  public.noel_unblock_merchant(text,text),
  public.noel_update_gift(text,bigint,text,text,text,text,text),
  public.noel_edit_offers(text,bigint,jsonb),
  public.noel_set_pinned(text,bigint,text[]),
  public.noel_set_extras(text,bigint,text,text,text,text),
  public.noel_set_with(text,bigint,bigint),
  public.noel_set_rank(text,bigint[]),
  public.noel_set_display(text,jsonb,text),
  public.noel_public()
from public;
grant execute on function
  public.noel_get(text),
  public.noel_add(text,text,text,text,text,numeric,text,jsonb,boolean,text),
  public.noel_remove(text,bigint),
  public.noel_set_top(text,bigint,boolean),
  public.noel_set_offers(text,bigint,numeric,text,jsonb),
  public.noel_set_family_code(text,text),
  public.noel_claim(text,bigint,text),
  public.noel_unclaim(text,bigint,text),
  public.noel_set_bought(text,bigint,text,boolean),
  public.noel_set_paid(text,bigint,text,numeric),
  public.noel_block_merchant(text,text,text),
  public.noel_unblock_merchant(text,text),
  public.noel_update_gift(text,bigint,text,text,text,text,text),
  public.noel_edit_offers(text,bigint,jsonb),
  public.noel_set_pinned(text,bigint,text[]),
  public.noel_set_extras(text,bigint,text,text,text,text),
  public.noel_set_with(text,bigint,bigint),
  public.noel_set_rank(text,bigint[]),
  public.noel_set_display(text,jsonb,text),
  public.noel_public()
to anon, authenticated;

revoke all on function public.noel_signal_decide(text,bigint,boolean), public.noel_set_aliases(text,bigint,text[]), public.noel_set_asin(text,bigint,text),
  public.noel_set_mpn(text,bigint,text), public.noel_status(text) from public;
grant execute on function public.noel_signal_decide(text,bigint,boolean), public.noel_set_aliases(text,bigint,text[]), public.noel_set_asin(text,bigint,text),
  public.noel_set_mpn(text,bigint,text), public.noel_status(text) to anon, authenticated;
-- Jamais appelables depuis l'API publique : réservées à service_role (droits accordés dans deploy/db/03-droits.sql)
revoke all on function public.noel_job_lease(text,int,text), public.noel_radar_purge() from public, anon, authenticated;
revoke all on function public.noel_serp_bump(text,int) from public, anon, authenticated;

-- Initialisation (remplacer les deux codes par des phrases longues, différentes l'une de l'autre).
-- Ne jamais écrire les vrais codes dans le dépôt :
-- insert into public.noel_config(title, owner_hash, family_hash)
-- values ('Liste de Noël de Dorian',
--         extensions.crypt('CODE_PROPRIETAIRE', extensions.gen_salt('bf')),
--         extensions.crypt('CODE_FAMILLE',      extensions.gen_salt('bf')));

-- NOTE VPS (novembre 2026) : sur le VPS, pg_cron / pg_net ne sont pas installés (les scripts deploy/db et restore-test les retirent)
-- et le relevé est une tâche planifiée Coolify (`price-refresh`). Le bloc ci-dessous ne sert plus qu'à l'historique de l'ancien hébergement Supabase.
-- Relevé automatique gratuit des prix : toutes les 2 heures, la fonction noel-refresh relit les pages des marchands de 3 fiches au plus
-- (celles dont la dernière lecture est la plus ancienne). Elle ne lit jamais les réservations : toutes les fiches sont traitées de la même façon.
-- Aucune recherche SerpAPI n'est utilisée. La clé « anon » (publique) est celle de index.html ; ne pas la remplacer par une clé secrète.
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- select cron.schedule('noel-refresh', '17 */2 * * *', $job$
--   select net.http_post(
--     url := 'https://pegojglksepcfvispcrs.supabase.co/functions/v1/noel-refresh',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'CLE_ANON_PUBLIQUE', 'Authorization', 'Bearer CLE_ANON_PUBLIQUE'),
--     body := '{"cron":true}'::jsonb) $job$);
