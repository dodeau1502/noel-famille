-- Liste de Noël famille : état actuel complet de la base (v6 : comptes, la fin du fichier ferme les fonctions à code)
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

-- 29 novembre 2026 : un compte (identifiant + code à 4 chiffres) et une liste par membre de la famille, rangés en groupes.
-- À appliquer en tant que noel_owner (`set role noel_owner;`, psql --single-transaction), après un pg_dump -Fc, d'abord sur noel-dev-db.
-- Les anciennes fonctions à code (noel_get, noel_public, noel_claim…) ne sont plus appelables depuis l'API publique : leur code reste en base.
-- Puis le propriétaire ouvre la page à l'adresse « #installation » et saisit son ancien code propriétaire (noel_setup, une seule fois).
--
-- Règle 1 : personne ne reçoit la moindre information de réservation sur SA PROPRE liste (ni champ, ni compteur, ni ordre).
-- Code oublié : seul l'administrateur peut réinitialiser (48 h pour choisir le nouveau). Limite assumée : l'administrateur pourrait
-- entrer dans un compte (ou en créer un faux) et voir qui a pris ses propres cadeaux.

create table public.noel_members (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 40),
  login text not null unique check (char_length(login) between 2 and 30),   -- normalisé par noel_login_key
  pin_hash text,                                  -- null tant que le compte n'est pas activé
  invite_hash text,                               -- empreinte du lien d'activation (usage unique)
  reset_until timestamptz,                        -- réinitialisation : le membre choisit un nouveau code avant cette date
  is_admin boolean not null default false,
  fails int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table public.noel_sessions (
  token_hash text primary key,
  member_id bigint not null references public.noel_members(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.noel_groups (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(name) between 1 and 40)
);

create table public.noel_group_members (
  group_id bigint not null references public.noel_groups(id) on delete cascade,
  member_id bigint not null references public.noel_members(id) on delete cascade,
  primary key (group_id, member_id)
);

alter table public.noel_gifts add column owner_id bigint references public.noel_members(id) on delete cascade;
-- Un cadeau retiré reste en base : celui qui l'avait pris doit le savoir, et son propriétaire ne doit pas pouvoir le déduire.
alter table public.noel_gifts add column removed_at timestamptz;
create index noel_gifts_owner on public.noel_gifts (owner_id);
alter table public.noel_claims add column member_id bigint references public.noel_members(id) on delete cascade;
alter table public.noel_gifts add column size text check (size is null or char_length(size) <= 80);
alter table public.noel_gifts add column color text check (color is null or char_length(color) <= 80);
alter table public.noel_gifts add column changed_at timestamptz;     -- dernière modification de ce qu'il faut acheter
-- Les adresses de produit dépassent souvent 500 caractères
alter table public.noel_gifts drop constraint if exists noel_gifts_url_check;
alter table public.noel_gifts add constraint noel_gifts_url_check check (url is null or char_length(url) <= 2000);

-- Participations à plusieurs. Mêmes règles que noel_claims : jamais lues pour la liste de leur propriétaire.
create table public.noel_shares (
  gift_id bigint not null references public.noel_gifts(id) on delete cascade,
  member_id bigint not null references public.noel_members(id) on delete cascade,
  amount numeric not null check (amount > 0 and amount < 100000),
  created_at timestamptz not null default now(),
  primary key (gift_id, member_id)
);

alter table public.noel_members       enable row level security;
alter table public.noel_sessions      enable row level security;
alter table public.noel_groups        enable row level security;
alter table public.noel_group_members enable row level security;
alter table public.noel_shares        enable row level security;
revoke all on public.noel_members, public.noel_sessions, public.noel_groups, public.noel_group_members, public.noel_shares from anon, authenticated;

---------------------------------------------------------------------------
-- Fonctions internes (jamais appelables depuis l'API publique)
---------------------------------------------------------------------------

-- « Zoé » = « zoe » = « ZOÉ »
create or replace function public.noel_login_key(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(translate(lower(trim(coalesce(p, ''))), 'àâäáãçéèêëíìîïñóòôöõúùûüýÿ', 'aaaaaceeeeiiiinooooouuuuyy'), '[^a-z0-9]', '', 'g')
$$;

create or replace function public.noel_hash(p text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function public.noel_throttled()
returns boolean language sql security definer set search_path = public as $$
  select count(*) >= 15 from public.noel_attempts where ip = public.noel_client_ip() and at > now() - interval '10 minutes'
$$;

create or replace function public.noel_fail()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.noel_attempts(ip) values (public.noel_client_ip());
  delete from public.noel_attempts where at < now() - interval '1 day';
end $$;

create or replace function public.noel_new_session(p_member bigint)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v text := encode(gen_random_bytes(32), 'hex');
begin
  insert into public.noel_sessions(token_hash, member_id) values (public.noel_hash(v), p_member);
  return v;
end $$;

-- Membre de la session, ou null. Un jeton fait 256 bits : pas de limite d'essais à tenir ici.
create or replace function public.noel_auth(p_token text)
returns public.noel_members language sql stable security definer set search_path = public as $$
  select m.* from public.noel_sessions s join public.noel_members m on m.id = s.member_id
   where s.token_hash = public.noel_hash(p_token)
$$;

-- Un membre voit sa liste et celles des membres qui partagent au moins un groupe avec lui.
create or replace function public.noel_sees(p_me bigint, p_other bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select p_me = p_other or exists (
    select 1 from public.noel_group_members a join public.noel_group_members b on b.group_id = a.group_id
     where a.member_id = p_me and b.member_id = p_other)
$$;

-- Les réservations d'avant les comptes sont au prénom : elles sont rattachées au compte du même prénom (jamais sur sa propre liste).
create or replace function public.noel_attach_claims(p_member bigint, p_name text)
returns void language sql security definer set search_path = public as $$
  update public.noel_claims c set member_id = p_member
    from public.noel_gifts g
   where g.id = c.gift_id and g.owner_id is distinct from p_member and c.member_id is null
     and public.noel_login_key(c.claimed_by) = public.noel_login_key(p_name)
$$;

---------------------------------------------------------------------------
-- Installation, activation, connexion
---------------------------------------------------------------------------

create or replace function public.noel_invite_new(p_member bigint)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v text := encode(gen_random_bytes(16), 'hex');
begin
  update public.noel_members set invite_hash = public.noel_hash(v) where id = p_member and pin_hash is null and reset_until is null;
  return v;
end $$;

-- L'ancien code propriétaire crée le compte administrateur et lui donne les cadeaux existants.
-- Relancée plus tard, la fonction sert à l'administrateur qui a oublié son code (même compte, nouveau lien).
create or replace function public.noel_setup(p_owner_code text, p_name text, p_login text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_owner_code); v_name text := trim(coalesce(p_name, ''));
        v_login text := public.noel_login_key(p_login); v_id bigint; v_group bigint;
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  select id into v_id from public.noel_members where is_admin and pin_hash is not null;
  if v_id is not null then
    update public.noel_members set pin_hash = null, reset_until = null, fails = 0, locked_until = null where id = v_id;
    delete from public.noel_sessions where member_id = v_id;
    return jsonb_build_object('ok', true, 'invite', public.noel_invite_new(v_id));
  end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_login) not between 2 and 30 then return jsonb_build_object('error', 'invalid'); end if;
  select id into v_id from public.noel_members where is_admin;
  if v_id is null then
    insert into public.noel_members(name, login, is_admin) values (v_name, v_login, true) returning id into v_id;
    insert into public.noel_groups(name) values ('Famille') returning id into v_group;
    insert into public.noel_group_members(group_id, member_id) values (v_group, v_id);
    -- Cadeaux existants : lien du magasin le moins cher quand la fiche n'en avait pas
    update public.noel_gifts g set url = (
        select o ->> 'url' from jsonb_array_elements(g.offers) o
         where o ->> 'url' ~ '^https://' and char_length(o ->> 'url') <= 2000 and o ->> 'price' ~ '^[0-9]+(\.[0-9]+)?$'
         order by (o ->> 'price')::numeric limit 1)
     where g.url is null and jsonb_typeof(g.offers) = 'array';
    update public.noel_gifts set owner_id = v_id where owner_id is null;
  else
    update public.noel_members set name = v_name, login = v_login where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'invite', public.noel_invite_new(v_id));
end $$;

create or replace function public.noel_invite_info(p_invite text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.noel_members;
begin
  if public.noel_throttled() then return jsonb_build_object('error', 'throttled'); end if;
  select * into m from public.noel_members where invite_hash = public.noel_hash(p_invite) and pin_hash is null;
  if m.id is null then perform public.noel_fail(); return jsonb_build_object('error', 'used'); end if;
  return jsonb_build_object('ok', true, 'name', m.name, 'login', m.login);
end $$;

create or replace function public.noel_activate(p_invite text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m public.noel_members;
begin
  if public.noel_throttled() then return jsonb_build_object('error', 'throttled'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'invalid'); end if;
  select * into m from public.noel_members where invite_hash = public.noel_hash(p_invite) and pin_hash is null for update;
  if m.id is null then perform public.noel_fail(); return jsonb_build_object('error', 'used'); end if;
  update public.noel_members set pin_hash = crypt(p_pin, gen_salt('bf')), invite_hash = null where id = m.id;
  perform public.noel_attach_claims(m.id, m.name);
  return jsonb_build_object('ok', true, 'token', public.noel_new_session(m.id));
end $$;

create or replace function public.noel_wrong_pin(p_member bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.noel_fail();
  update public.noel_members set fails = fails + 1,
    locked_until = case when (fails + 1) % 5 <> 0 then null
                        when fails + 1 = 5 then now() + interval '15 minutes'
                        when fails + 1 = 10 then now() + interval '1 hour'
                        else now() + interval '24 hours' end
   where id = p_member;
end $$;

-- Code à 4 chiffres : 5 erreurs bloquent le compte 15 minutes, 10 une heure, ensuite 24 heures toutes les 5 erreurs.
create or replace function public.noel_login(p_login text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m public.noel_members;
begin
  if public.noel_throttled() then return jsonb_build_object('error', 'throttled'); end if;
  select * into m from public.noel_members where login = public.noel_login_key(p_login) and (pin_hash is not null or reset_until > now()) for update;
  if m.id is null then perform public.noel_fail(); return jsonb_build_object('error', 'denied'); end if;
  -- Réinitialisation lancée par l'administrateur : la page propose de choisir un nouveau code
  if m.pin_hash is null then return jsonb_build_object('reset', true, 'name', m.name, 'login', m.login); end if;
  if coalesce(p_pin, '') = '' then return jsonb_build_object('error', 'pin'); end if;
  if m.locked_until > now() then return jsonb_build_object('error', 'locked'); end if;
  if m.pin_hash <> crypt(p_pin, m.pin_hash) then
    perform public.noel_wrong_pin(m.id);
    return jsonb_build_object('error', 'denied');
  end if;
  update public.noel_members set fails = 0, locked_until = null where id = m.id;
  return jsonb_build_object('ok', true, 'token', public.noel_new_session(m.id));
end $$;

create or replace function public.noel_reset_choose(p_login text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m public.noel_members;
begin
  if public.noel_throttled() then return jsonb_build_object('error', 'throttled'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'invalid'); end if;
  select * into m from public.noel_members where login = public.noel_login_key(p_login) and pin_hash is null and reset_until > now() for update;
  if m.id is null then perform public.noel_fail(); return jsonb_build_object('error', 'denied'); end if;
  update public.noel_members set pin_hash = crypt(p_pin, gen_salt('bf')), reset_until = null, fails = 0, locked_until = null where id = m.id;
  return jsonb_build_object('ok', true, 'token', public.noel_new_session(m.id));
end $$;

-- Changer son propre code : les autres appareils sont déconnectés.
create or replace function public.noel_change_pin(p_token text, p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if p_new is null or p_new !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'invalid'); end if;
  if me.locked_until > now() then return jsonb_build_object('error', 'locked'); end if;
  if me.pin_hash is null or me.pin_hash <> crypt(coalesce(p_old, ''), me.pin_hash) then
    perform public.noel_wrong_pin(me.id);
    return jsonb_build_object('error', 'oldpin');
  end if;
  update public.noel_members set pin_hash = crypt(p_new, gen_salt('bf')), fails = 0, locked_until = null where id = me.id;
  delete from public.noel_sessions where member_id = me.id and token_hash <> public.noel_hash(p_token);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_logout(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from public.noel_sessions where token_hash = public.noel_hash(p_token);
  return jsonb_build_object('ok', true);
end $$;

-- Réservations faites sur cet appareil avant les comptes (prénom mémorisé ou jeton anonyme)
create or replace function public.noel_adopt(p_token text, p_old text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if char_length(trim(coalesce(p_old, ''))) between 1 and 40 then perform public.noel_attach_claims(me.id, p_old); end if;
  return jsonb_build_object('ok', true);
end $$;

---------------------------------------------------------------------------
-- Listes
---------------------------------------------------------------------------

-- Menu : les membres par groupe, et « ce que j'offre » (jamais rien sur ma propre liste).
create or replace function public.noel_home(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  return jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'admin', me.is_admin,
                             'count', (select count(*) from public.noel_gifts g where g.owner_id = me.id and g.removed_at is null)),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', gr.id, 'name', gr.name,
        'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name,
              'count', (select count(*) from public.noel_gifts g where g.owner_id = m.id and g.removed_at is null),
              -- ce que JE lui offre (m n'est jamais moi)
              'offered', (select count(*) from public.noel_gifts g where g.owner_id = m.id and g.removed_at is null
                            and (exists (select 1 from public.noel_claims c where c.gift_id = g.id and c.member_id = me.id)
                              or exists (select 1 from public.noel_shares s where s.gift_id = g.id and s.member_id = me.id)))) order by m.name)
            from public.noel_group_members x join public.noel_members m on m.id = x.member_id
           where x.group_id = gr.id and m.id <> me.id), '[]'::jsonb)) order by gr.name)
      from public.noel_groups gr join public.noel_group_members y on y.group_id = gr.id and y.member_id = me.id), '[]'::jsonb),
    'offering', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'price', g.price, 'url', g.url, 'image', g.image_url,
          'details', concat_ws(' · ', g.size, g.color, g.variant, g.note),
          'ownerName', o.name, 'removed', g.removed_at is not null,
          'changed', coalesce(g.changed_at > x.at, false),
          'bought', x.bought, 'amount', x.amount,
          'shares', case when x.amount is null then '[]'::jsonb else
              (select jsonb_agg(jsonb_build_object('name', m.name, 'amount', s.amount, 'mine', m.id = me.id) order by s.created_at)
                 from public.noel_shares s join public.noel_members m on m.id = s.member_id where s.gift_id = g.id) end)
        order by o.name, x.at)
        from (select c.gift_id, c.claimed_at as at, c.bought, null::numeric as amount from public.noel_claims c where c.member_id = me.id
              union all
              select s.gift_id, s.created_at, false, s.amount from public.noel_shares s where s.member_id = me.id) x
        join public.noel_gifts g on g.id = x.gift_id
        join public.noel_members o on o.id = g.owner_id
       where g.owner_id <> me.id), '[]'::jsonb));
end $$;

create or replace function public.noel_list(p_token text, p_member bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token); who public.noel_members; v_mine boolean; res jsonb;
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  select * into who from public.noel_members where id = p_member;
  if who.id is null or not public.noel_sees(me.id, who.id) then return jsonb_build_object('error', 'denied'); end if;
  v_mine := who.id = me.id;
  if v_mine then
    -- Aucune lecture de noel_claims ni de noel_shares (règle 1)
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'size', g.size, 'color', g.color, 'note', concat_ws(' · ', g.variant, g.note),
             'url', g.url, 'image', g.image_url, 'price', g.price, 'store', g.store, 'top', g.top)
           order by g.top desc, g.rank nulls last, g.created_at, g.id), '[]'::jsonb)
      into res from public.noel_gifts g where g.owner_id = who.id and g.removed_at is null;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'size', g.size, 'color', g.color, 'note', concat_ws(' · ', g.variant, g.note),
             'url', g.url, 'image', g.image_url, 'price', g.price, 'store', g.store, 'top', g.top,
             'taken', c.gift_id is not null,
             'mine', coalesce(c.member_id = me.id, false),
             -- Les anciennes réservations sans prénom portent un jeton de 16 caractères : pas de nom à montrer
             'by', coalesce((select m.name from public.noel_members m where m.id = c.member_id),
                            case when c.claimed_by !~ '^[0-9a-f]{16}$' then c.claimed_by end),
             'shares', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'amount', s.amount, 'mine', m.id = me.id) order by s.created_at)
                                   from public.noel_shares s join public.noel_members m on m.id = s.member_id where s.gift_id = g.id), '[]'::jsonb))
           order by g.top desc, g.rank nulls last, g.created_at, g.id), '[]'::jsonb)
      into res from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id
     where g.owner_id = who.id and g.removed_at is null;
  end if;
  return jsonb_build_object('member', jsonb_build_object('id', who.id, 'name', who.name), 'mine', v_mine, 'gifts', res);
end $$;

-- p_id null : ajout ; sinon modification d'un cadeau de MA liste.
create or replace function public.noel_gift_save(p_token text, p_id bigint, p_title text, p_url text, p_size text, p_color text, p_note text,
                                                 p_image text, p_price numeric, p_store text, p_top boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token); prev public.noel_gifts;
        t text := trim(coalesce(p_title, '')); u text := nullif(trim(coalesce(p_url, '')), ''); n text := nullif(trim(coalesce(p_note, '')), '');
        z text := nullif(trim(coalesce(p_size, '')), ''); k text := nullif(trim(coalesce(p_color, '')), '');
        i text := nullif(trim(coalesce(p_image, '')), ''); s text := nullif(left(trim(coalesce(p_store, '')), 80), '');
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if char_length(t) not between 1 and 120 or char_length(n) > 500 or char_length(z) > 80 or char_length(k) > 80
     or (u is not null and (u !~* '^https?://' or char_length(u) > 2000))
     or (i is not null and (i !~ '^https://' or char_length(i) > 2000))
     or (p_price is not null and (p_price <= 0 or p_price >= 100000)) then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_id is null then
    if (select count(*) from public.noel_gifts where owner_id = me.id and removed_at is null) >= 100 then return jsonb_build_object('error', 'full'); end if;
    insert into public.noel_gifts(owner_id, title, url, size, color, note, image_url, price, store, top)
    values (me.id, t, u, z, k, n, i, p_price, s, coalesce(p_top, false));
  else
    select * into prev from public.noel_gifts where id = p_id and owner_id = me.id and removed_at is null for update;
    if prev.id is null then return jsonb_build_object('error', 'denied'); end if;
    update public.noel_gifts set title = t, url = u, size = z, color = k, note = n, variant = null, image_url = i, price = p_price, store = s,
      top = coalesce(p_top, false),
      -- Daté qu'il soit réservé ou non (règle 1)
      changed_at = case when (prev.title, prev.url, prev.size, prev.color, nullif(concat_ws(' · ', prev.variant, prev.note), ''))
                             is distinct from (t, u, z, k, n) then now() else prev.changed_at end
     where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Toujours le même geste, qu'il soit réservé ou non : le propriétaire ne peut rien en déduire.
create or replace function public.noel_gift_delete(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  update public.noel_gifts set removed_at = now() where id = p_id and owner_id = me.id and removed_at is null;
  if not found then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_take(p_token text, p_gift bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token); g public.noel_gifts;
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  -- verrou sur la fiche : « je l'offre » et « je participe » ne peuvent pas se croiser
  select * into g from public.noel_gifts where id = p_gift and removed_at is null for update;
  -- Sa propre liste : même réponse pour un cadeau libre ou pris
  if g.id is null or g.owner_id is null or g.owner_id = me.id or not public.noel_sees(me.id, g.owner_id) then
    return jsonb_build_object('error', 'denied');
  end if;
  if exists (select 1 from public.noel_shares where gift_id = p_gift) then return jsonb_build_object('error', 'shared'); end if;
  insert into public.noel_claims(gift_id, claimed_by, member_id) values (p_gift, me.name, me.id);
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('error', 'taken');
end $$;

-- Participer avec un montant (ou le changer).
create or replace function public.noel_share(p_token text, p_gift bigint, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token); g public.noel_gifts;
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  select * into g from public.noel_gifts where id = p_gift and removed_at is null for update;
  if g.id is null or g.owner_id is null or g.owner_id = me.id or not public.noel_sees(me.id, g.owner_id) then
    return jsonb_build_object('error', 'denied');
  end if;
  if p_amount is null or p_amount < 1 or p_amount >= 100000 then return jsonb_build_object('error', 'invalid'); end if;
  if exists (select 1 from public.noel_claims where gift_id = p_gift) then return jsonb_build_object('error', 'taken'); end if;
  insert into public.noel_shares(gift_id, member_id, amount) values (p_gift, me.id, round(p_amount, 2))
    on conflict (gift_id, member_id) do update set amount = excluded.amount;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_release(p_token text, p_gift bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  delete from public.noel_claims where gift_id = p_gift and member_id = me.id;
  delete from public.noel_shares where gift_id = p_gift and member_id = me.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_bought(p_token text, p_gift bigint, p_bought boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  update public.noel_claims set bought = coalesce(p_bought, false) where gift_id = p_gift and member_id = me.id;
  return jsonb_build_object('ok', true);
end $$;

---------------------------------------------------------------------------
-- Administration (membres et groupes ; aucune donnée de réservation)
---------------------------------------------------------------------------

create or replace function public.noel_is_admin(p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((public.noel_auth(p_token)).is_admin, false)
$$;

create or replace function public.noel_admin(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'login', m.login, 'admin', m.is_admin,
        'active', m.pin_hash is not null,
        'reset', case when m.reset_until is null then null when m.reset_until > now() then 'pending' else 'expired' end,
        'groups', coalesce((select jsonb_agg(x.group_id) from public.noel_group_members x where x.member_id = m.id), '[]'::jsonb)) order by m.name)
      from public.noel_members m), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', gr.id, 'name', gr.name) order by gr.name) from public.noel_groups gr), '[]'::jsonb));
end $$;

create or replace function public.noel_admin_member_add(p_token text, p_name text, p_login text, p_groups bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, '')); v_login text := public.noel_login_key(p_login); v_id bigint;
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if char_length(v_name) not between 1 and 40 or char_length(v_login) not between 2 and 30 then return jsonb_build_object('error', 'invalid'); end if;
  insert into public.noel_members(name, login) values (v_name, v_login) returning id into v_id;
  insert into public.noel_group_members(group_id, member_id) select id, v_id from public.noel_groups where id = any(coalesce(p_groups, '{}'));
  return jsonb_build_object('ok', true, 'login', v_login, 'invite', public.noel_invite_new(v_id));
exception when unique_violation then
  return jsonb_build_object('error', 'exists');
end $$;

-- Code oublié : le compte est déconnecté partout et le membre a 48 heures pour choisir un nouveau code en entrant son identifiant.
create or replace function public.noel_admin_reset(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  update public.noel_members set pin_hash = null, invite_hash = null, reset_until = now() + interval '48 hours', fails = 0, locked_until = null
   where id = p_member and not is_admin and (pin_hash is not null or reset_until is not null);
  if not found then return jsonb_build_object('error', 'denied'); end if;
  delete from public.noel_sessions where member_id = p_member;
  return jsonb_build_object('ok', true);
end $$;

-- Nouveau lien d'activation, seulement pour un compte jamais activé.
create or replace function public.noel_admin_invite(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if not exists (select 1 from public.noel_members where id = p_member and pin_hash is null and reset_until is null) then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('ok', true, 'invite', public.noel_invite_new(p_member));
end $$;

create or replace function public.noel_admin_member_groups(p_token text, p_member bigint, p_groups bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if not exists (select 1 from public.noel_members where id = p_member) then return jsonb_build_object('error', 'invalid'); end if;
  delete from public.noel_group_members where member_id = p_member;
  insert into public.noel_group_members(group_id, member_id) select id, p_member from public.noel_groups where id = any(coalesce(p_groups, '{}'));
  return jsonb_build_object('ok', true);
end $$;

-- Supprime le compte, sa liste et ce qu'il avait pris. Jamais un administrateur.
create or replace function public.noel_admin_member_remove(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  delete from public.noel_members where id = p_member and not is_admin;
  if not found then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_admin_group_add(p_token text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := trim(coalesce(p_name, ''));
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if char_length(v) not between 1 and 40 then return jsonb_build_object('error', 'invalid'); end if;
  insert into public.noel_groups(name) values (v);
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('error', 'exists');
end $$;

create or replace function public.noel_admin_group_remove(p_token text, p_group bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  delete from public.noel_groups where id = p_group;
  return jsonb_build_object('ok', true);
end $$;

---------------------------------------------------------------------------
-- Droits
---------------------------------------------------------------------------

-- Anciennes fonctions à code : fermées à l'API publique. Sinon un code famille encore connu d'un appareil permettrait
-- à quelqu'un de voir qui a pris ses propres cadeaux, et noel_public montrerait toutes les listes sans compte.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'noel\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.noel_setup(text,text,text),
  public.noel_invite_info(text),
  public.noel_activate(text,text),
  public.noel_login(text,text),
  public.noel_logout(text),
  public.noel_adopt(text,text),
  public.noel_home(text),
  public.noel_list(text,bigint),
  public.noel_gift_save(text,bigint,text,text,text,text,text,text,numeric,text,boolean),
  public.noel_gift_delete(text,bigint),
  public.noel_share(text,bigint,numeric),
  public.noel_reset_choose(text,text),
  public.noel_change_pin(text,text,text),
  public.noel_admin_reset(text,bigint),
  public.noel_take(text,bigint),
  public.noel_release(text,bigint),
  public.noel_bought(text,bigint,boolean),
  public.noel_admin(text),
  public.noel_admin_member_add(text,text,text,bigint[]),
  public.noel_admin_invite(text,bigint),
  public.noel_admin_member_groups(text,bigint,bigint[]),
  public.noel_admin_member_remove(text,bigint),
  public.noel_admin_group_add(text,text),
  public.noel_admin_group_remove(text,bigint)
to anon, authenticated;

-- PostgREST relit la liste des fonctions
notify pgrst, 'reload schema';

-- 30 novembre 2026 : l'administrateur peut ajouter, modifier et retirer des cadeaux sur la liste de n'importe qui.
-- À appliquer après 2026-11-29-noel-comptes, en tant que noel_owner (psql --single-transaction), après un pg_dump -Fc.
-- Règle 1 inchangée : sur SA propre liste, l'administrateur ne voit rien non plus (noel_list ne lit pas les réservations).

-- Un membre voit sa liste et celles de ses groupes ; l'administrateur les voit toutes (pour les remplir).
create or replace function public.noel_sees(p_me bigint, p_other bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select p_me = p_other
      or exists (select 1 from public.noel_members m where m.id = p_me and m.is_admin)
      or exists (select 1 from public.noel_group_members a join public.noel_group_members b on b.group_id = a.group_id
                  where a.member_id = p_me and b.member_id = p_other)
$$;

-- p_owner (en dernier, facultatif) : la liste où ajouter. La page précédente, qui ne l'envoie pas, continue de marcher.
drop function public.noel_gift_save(text,bigint,text,text,text,text,text,text,numeric,text,boolean);
create or replace function public.noel_gift_save(p_token text, p_id bigint, p_title text, p_url text, p_size text, p_color text, p_note text,
                                                 p_image text, p_price numeric, p_store text, p_top boolean, p_owner bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token); prev public.noel_gifts; v_owner bigint;
        t text := trim(coalesce(p_title, '')); u text := nullif(trim(coalesce(p_url, '')), ''); n text := nullif(trim(coalesce(p_note, '')), '');
        z text := nullif(trim(coalesce(p_size, '')), ''); k text := nullif(trim(coalesce(p_color, '')), '');
        i text := nullif(trim(coalesce(p_image, '')), ''); s text := nullif(left(trim(coalesce(p_store, '')), 80), '');
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if char_length(t) not between 1 and 120 or char_length(n) > 500 or char_length(z) > 80 or char_length(k) > 80
     or (u is not null and (u !~* '^https?://' or char_length(u) > 2000))
     or (i is not null and (i !~ '^https://' or char_length(i) > 2000))
     or (p_price is not null and (p_price <= 0 or p_price >= 100000)) then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_id is null then
    v_owner := coalesce(p_owner, me.id);
    if v_owner <> me.id and not (me.is_admin and exists (select 1 from public.noel_members where id = v_owner)) then
      return jsonb_build_object('error', 'denied');
    end if;
    if (select count(*) from public.noel_gifts where owner_id = v_owner and removed_at is null) >= 100 then return jsonb_build_object('error', 'full'); end if;
    insert into public.noel_gifts(owner_id, title, url, size, color, note, image_url, price, store, top)
    values (v_owner, t, u, z, k, n, i, p_price, s, coalesce(p_top, false));
  else
    select * into prev from public.noel_gifts where id = p_id and (owner_id = me.id or me.is_admin) and removed_at is null for update;
    if prev.id is null then return jsonb_build_object('error', 'denied'); end if;
    update public.noel_gifts set title = t, url = u, size = z, color = k, note = n, variant = null, image_url = i, price = p_price, store = s,
      top = coalesce(p_top, false),
      -- Daté qu'il soit réservé ou non (règle 1)
      changed_at = case when (prev.title, prev.url, prev.size, prev.color, nullif(concat_ws(' · ', prev.variant, prev.note), ''))
                             is distinct from (t, u, z, k, n) then now() else prev.changed_at end
     where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_gift_delete(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  update public.noel_gifts set removed_at = now() where id = p_id and (owner_id = me.id or me.is_admin) and removed_at is null;
  if not found then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.noel_gift_save(text,bigint,text,text,text,text,text,text,numeric,text,boolean,bigint) from public;
grant execute on function public.noel_gift_save(text,bigint,text,text,text,text,text,text,numeric,text,boolean,bigint) to anon, authenticated;

notify pgrst, 'reload schema';

-- 1er décembre 2026 : ne jamais perdre une liste par erreur.
-- À appliquer après 2026-11-30-noel-admin-listes, en tant que noel_owner (psql --single-transaction), après un pg_dump -Fc.
-- 1) Journal : l'état d'avant chaque modification ou suppression est gardé.
-- 2) Aucune suppression physique d'un cadeau ou d'un compte (même par une erreur de code ou de SQL).
-- 3) Corbeille : un cadeau retiré se remet ; un compte supprimé se restaure.
-- Le journal contient des réservations : il n'est jamais lisible par l'API (règle 1).

create table public.noel_journal (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tbl text not null,
  op text not null,                -- 'update' ou 'delete'
  data jsonb not null              -- la ligne AVANT
);
create index noel_journal_at on public.noel_journal (at);
alter table public.noel_journal enable row level security;
revoke all on public.noel_journal from anon, authenticated;

create or replace function public.noel_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Les champs techniques ne comptent pas comme une modification
  if tg_op = 'UPDATE' and (to_jsonb(old) - array['rank','checked_at','next_check_at','fails','locked_until'])
                        = (to_jsonb(new) - array['rank','checked_at','next_check_at','fails','locked_until']) then
    return null;
  end if;
  insert into public.noel_journal(tbl, op, data) values (tg_table_name, lower(tg_op), to_jsonb(old) - array['pin_hash','invite_hash']);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['noel_gifts','noel_claims','noel_shares','noel_group_members','noel_groups'] loop
    execute format('create trigger noel_journal_trg after update or delete on public.%I for each row execute function public.noel_log()', t);
  end loop;
end $$;
-- Comptes : pas les connexions, seulement le prénom, l'identifiant et la suppression
create trigger noel_journal_trg after delete or update of name, login on public.noel_members for each row execute function public.noel_log();

-- Dernier rempart. Pour une vraie suppression voulue (jamais depuis l'application) : set local noel.allow_delete = 'on';
create or replace function public.noel_no_delete()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('noel.allow_delete', true), '') <> 'on' then
    raise exception 'Suppression interdite sur % : les cadeaux et les comptes sont retirés, jamais effacés', tg_table_name;
  end if;
  if tg_level = 'ROW' then return old; end if;
  return null;
end $$;
create trigger noel_keep_row before delete on public.noel_gifts   for each row execute function public.noel_no_delete();
create trigger noel_keep_row before delete on public.noel_members for each row execute function public.noel_no_delete();
create trigger noel_keep_all before truncate on public.noel_gifts   for each statement execute function public.noel_no_delete();
create trigger noel_keep_all before truncate on public.noel_members for each statement execute function public.noel_no_delete();
create trigger noel_keep_all before truncate on public.noel_claims  for each statement execute function public.noel_no_delete();
create trigger noel_keep_all before truncate on public.noel_shares  for each statement execute function public.noel_no_delete();

alter table public.noel_members add column removed_at timestamptz;

-- Corbeille d'une liste : la sienne, ou n'importe laquelle pour l'administrateur. Aucune donnée de réservation.
create or replace function public.noel_trash(p_token text, p_member bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if p_member is distinct from me.id and not me.is_admin then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('gifts', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'image', g.image_url) order by g.removed_at desc)
    from public.noel_gifts g where g.owner_id = p_member and g.removed_at is not null), '[]'::jsonb));
end $$;

create or replace function public.noel_gift_restore(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  update public.noel_gifts set removed_at = null where id = p_id and (owner_id = me.id or me.is_admin) and removed_at is not null;
  if not found then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- « Supprimer un compte » : plus d'accès et plus visible, mais la liste reste en base. Ce que la personne offrait est libéré
-- (gardé au journal, à la même heure que removed_at, pour la restauration).
create or replace function public.noel_admin_member_remove(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  update public.noel_members set removed_at = now(), pin_hash = null, invite_hash = null,
      -- date passée : après restauration, l'administrateur propose « Réinitialiser le code »
      reset_until = case when pin_hash is not null or reset_until is not null then now() end
   where id = p_member and not is_admin and removed_at is null;
  if not found then return jsonb_build_object('error', 'denied'); end if;
  delete from public.noel_sessions where member_id = p_member;
  delete from public.noel_group_members where member_id = p_member;
  delete from public.noel_claims where member_id = p_member;
  delete from public.noel_shares where member_id = p_member;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_admin_member_restore(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  select removed_at into v_at from public.noel_members where id = p_member for update;
  if v_at is null then return jsonb_build_object('error', 'denied'); end if;
  update public.noel_members set removed_at = null where id = p_member;
  insert into public.noel_group_members(group_id, member_id)
    select (j.data ->> 'group_id')::bigint, p_member from public.noel_journal j
     where j.tbl = 'noel_group_members' and j.op = 'delete' and j.at = v_at and (j.data ->> 'member_id')::bigint = p_member
       and exists (select 1 from public.noel_groups g where g.id = (j.data ->> 'group_id')::bigint)
    on conflict do nothing;
  -- Ses réservations et participations reviennent, sauf si quelqu'un d'autre a pris le cadeau entre-temps
  insert into public.noel_claims
    select r.* from public.noel_journal j, jsonb_populate_record(null::public.noel_claims, j.data) r
     where j.tbl = 'noel_claims' and j.op = 'delete' and j.at = v_at and (j.data ->> 'member_id')::bigint = p_member
       and not exists (select 1 from public.noel_shares s where s.gift_id = r.gift_id)
    on conflict do nothing;
  insert into public.noel_shares
    select r.* from public.noel_journal j, jsonb_populate_record(null::public.noel_shares, j.data) r
     where j.tbl = 'noel_shares' and j.op = 'delete' and j.at = v_at and (j.data ->> 'member_id')::bigint = p_member
       and not exists (select 1 from public.noel_claims c where c.gift_id = r.gift_id)
    on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.noel_admin(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'login', m.login, 'admin', m.is_admin,
        'active', m.pin_hash is not null,
        'reset', case when m.reset_until is null then null when m.reset_until > now() then 'pending' else 'expired' end,
        'groups', coalesce((select jsonb_agg(x.group_id) from public.noel_group_members x where x.member_id = m.id), '[]'::jsonb)) order by m.name)
      from public.noel_members m where m.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.name)
      from public.noel_members m where m.removed_at is not null), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', gr.id, 'name', gr.name) order by gr.name) from public.noel_groups gr), '[]'::jsonb),
    'removedGroups', coalesce((select jsonb_agg(jsonb_build_object('entry', j.id, 'name', j.data ->> 'name') order by j.at desc) from public.noel_journal j
      where j.tbl = 'noel_groups' and j.op = 'delete'
        and not exists (select 1 from public.noel_groups g where g.id = (j.data ->> 'id')::bigint or g.name = j.data ->> 'name')
        -- une seule entrée par groupe : la dernière suppression
        and not exists (select 1 from public.noel_journal k where k.tbl = 'noel_groups' and k.op = 'delete' and k.data ->> 'id' = j.data ->> 'id' and k.id > j.id)), '[]'::jsonb));
end $$;

-- Groupe supprimé : il revient avec ses membres (p_entry : sa ligne au journal)
create or replace function public.noel_admin_group_restore(p_token text, p_entry bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.noel_journal; v_id bigint;
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  select * into j from public.noel_journal where id = p_entry and tbl = 'noel_groups' and op = 'delete';
  if j.id is null then return jsonb_build_object('error', 'denied'); end if;
  v_id := (j.data ->> 'id')::bigint;
  insert into public.noel_groups(id, name) overriding system value values (v_id, j.data ->> 'name');
  insert into public.noel_group_members(group_id, member_id)
    select v_id, (x.data ->> 'member_id')::bigint from public.noel_journal x
      join public.noel_members m on m.id = (x.data ->> 'member_id')::bigint and m.removed_at is null
     where x.tbl = 'noel_group_members' and x.op = 'delete' and x.at = j.at and (x.data ->> 'group_id')::bigint = v_id
    on conflict do nothing;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('error', 'exists');
end $$;

-- Un compte supprimé ne reçoit pas de nouveau lien
create or replace function public.noel_admin_invite(p_token text, p_member bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if not exists (select 1 from public.noel_members where id = p_member and pin_hash is null and reset_until is null and removed_at is null) then
    return jsonb_build_object('error', 'denied');
  end if;
  return jsonb_build_object('ok', true, 'invite', public.noel_invite_new(p_member));
end $$;

revoke all on function public.noel_log(), public.noel_no_delete() from public, anon, authenticated;
revoke all on function public.noel_trash(text,bigint), public.noel_gift_restore(text,bigint), public.noel_admin_member_restore(text,bigint), public.noel_admin_group_restore(text,bigint) from public;
grant execute on function public.noel_trash(text,bigint), public.noel_gift_restore(text,bigint), public.noel_admin_member_restore(text,bigint), public.noel_admin_group_restore(text,bigint) to anon, authenticated;

-- ===== Migration 2026-12-02-noel-photos (appliquée en production le 28 novembre 2026) =====
-- 2 décembre 2026 : photos envoyées depuis le téléphone (photo du cadeau, ou morceau recadré d'une capture d'écran).
-- À appliquer en tant que noel_owner (`set role noel_owner;`, psql --single-transaction), après un pg_dump -Fc, d'abord sur une copie.
-- Puis deploy/db/03-droits.sql (droit de lecture de service_role).
--
-- Les photos sont DANS la base : elles partent donc dans la sauvegarde quotidienne (pg_dump), comme les listes.
-- Une photo n'est jamais modifiée ni effacée (déclencheur noel_no_delete) : rien à journaliser.
-- Seul un JPEG déjà réduit par la page est accepté (300 Ko au plus). La capture d'écran entière n'est jamais gardée.
-- Aucun lien avec les réservations (règle 1).

create table public.noel_photos (
  id text primary key check (id ~ '^[a-f0-9]{24}$'),
  member_id bigint not null references public.noel_members(id),
  data bytea not null check (octet_length(data) between 100 and 300000),
  created_at timestamptz not null default now()
);
create index noel_photos_member on public.noel_photos(member_id, created_at);
alter table public.noel_photos enable row level security;
revoke all on public.noel_photos from public, anon, authenticated;
create trigger noel_keep_row before delete on public.noel_photos for each row execute function public.noel_no_delete();
create trigger noel_keep_all before truncate on public.noel_photos for each statement execute function public.noel_no_delete();

-- Ajout d'une photo par un membre connecté. p_data : JPEG en base64. Renvoie {"ok":true,"id":"…"} ou {"error":…}.
create or replace function public.noel_photo_add(p_token text, p_data text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me public.noel_members := public.noel_auth(p_token); b bytea; v text;
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if p_data is null or char_length(p_data) > 410000 then return jsonb_build_object('error', 'invalid'); end if;
  begin b := decode(p_data, 'base64'); exception when others then return jsonb_build_object('error', 'invalid'); end;
  -- JPEG seulement (signature FF D8 FF)
  if octet_length(b) < 100 or octet_length(b) > 300000 or substring(b from 1 for 3) <> '\xffd8ff'::bytea then
    return jsonb_build_object('error', 'invalid');
  end if;
  if (select count(*) from public.noel_photos where member_id = me.id and created_at > now() - interval '1 hour') >= 40 then
    return jsonb_build_object('error', 'throttled');
  end if;
  v := encode(gen_random_bytes(12), 'hex');
  insert into public.noel_photos(id, member_id, data) values (v, me.id, b);
  return jsonb_build_object('ok', true, 'id', v);
end $$;
revoke all on function public.noel_photo_add(text,text) from public;
grant execute on function public.noel_photo_add(text,text) to anon, authenticated;

-- Lecture d'une photo par le serveur (adresse /photo/<id>.jpg). Clé de service seulement, jamais relayée de l'extérieur.
create or replace function public.noel_photo_get(p_id text)
returns text language sql stable security definer set search_path = public as $$
  select encode(data, 'base64') from public.noel_photos where id = p_id and p_id ~ '^[a-f0-9]{24}$'
$$;
revoke all on function public.noel_photo_get(text) from public, anon, authenticated;

-- ===== Migration 2026-12-03-noel-vues (appliquée en production le 28 novembre 2026) =====
-- 3 décembre 2026 : comptes sans liste de Noël, et choix des listes qu'une personne voit dans ses groupes (demande de Dorian).
-- À appliquer en tant que noel_owner (`set role noel_owner;`, psql --single-transaction), après un pg_dump -Fc, d'abord sur une copie.
--
-- has_list = false : la personne se connecte (identifiant + code) et peut prendre ou participer, mais n'a pas de liste :
--   elle n'apparaît pas aux autres et personne ne peut ouvrir sa liste (sauf l'administrateur). Rien n'est effacé si on la décoche.
-- sees_all = false : la personne ne voit, dans ses groupes, que les listes cochées dans noel_member_sees.
-- Réglages faits par l'administrateur seul. Règle 1 inchangée : rien de tout cela ne touche aux réservations.

alter table public.noel_members add column has_list boolean not null default true,
                                add column sees_all boolean not null default true;

create table public.noel_member_sees (
  member_id bigint not null references public.noel_members(id),
  owner_id bigint not null references public.noel_members(id),
  primary key (member_id, owner_id),
  check (member_id <> owner_id)
);
alter table public.noel_member_sees enable row level security;
revoke all on public.noel_member_sees from public, anon, authenticated;
create trigger noel_journal_trg after update or delete on public.noel_member_sees for each row execute function public.noel_log();
-- Le journal des comptes garde aussi ces deux réglages
drop trigger noel_journal_trg on public.noel_members;
create trigger noel_journal_trg after delete or update of name, login, has_list, sees_all on public.noel_members for each row execute function public.noel_log();

-- Qui voit la liste de qui : soi-même ; l'administrateur (pour remplir) ; sinon une personne qui a une liste, d'un groupe commun,
-- si l'on voit toutes les listes ou si elle est cochée. Utilisée par noel_list, noel_take, noel_share.
create or replace function public.noel_sees(p_me bigint, p_other bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select p_me = p_other
      or exists (select 1 from public.noel_members m where m.id = p_me and m.is_admin)
      or (exists (select 1 from public.noel_members o where o.id = p_other and o.has_list)
          and exists (select 1 from public.noel_group_members a join public.noel_group_members b on b.group_id = a.group_id
                       where a.member_id = p_me and b.member_id = p_other)
          and (exists (select 1 from public.noel_members m where m.id = p_me and m.sees_all)
               or exists (select 1 from public.noel_member_sees v where v.member_id = p_me and v.owner_id = p_other)))
$$;

-- Accueil : mêmes règles pour la liste des personnes (l'administrateur y voit ses groupes comme tout le monde) ; « hasList » pour la page.
create or replace function public.noel_home(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  return jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'admin', me.is_admin, 'hasList', me.has_list,
                             'count', (select count(*) from public.noel_gifts g where g.owner_id = me.id and g.removed_at is null)),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', gr.id, 'name', gr.name,
        'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name,
              'count', (select count(*) from public.noel_gifts g where g.owner_id = m.id and g.removed_at is null),
              -- ce que JE lui offre (m n'est jamais moi)
              'offered', (select count(*) from public.noel_gifts g where g.owner_id = m.id and g.removed_at is null
                            and (exists (select 1 from public.noel_claims c where c.gift_id = g.id and c.member_id = me.id)
                              or exists (select 1 from public.noel_shares s where s.gift_id = g.id and s.member_id = me.id)))) order by m.name)
            from public.noel_group_members x join public.noel_members m on m.id = x.member_id
           where x.group_id = gr.id and m.id <> me.id and m.has_list
             and (me.sees_all or exists (select 1 from public.noel_member_sees v where v.member_id = me.id and v.owner_id = m.id))), '[]'::jsonb)) order by gr.name)
      from public.noel_groups gr join public.noel_group_members y on y.group_id = gr.id and y.member_id = me.id), '[]'::jsonb),
    'offering', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'price', g.price, 'url', g.url, 'image', g.image_url,
          'details', concat_ws(' · ', g.size, g.color, g.variant, g.note),
          'ownerName', o.name, 'removed', g.removed_at is not null,
          'changed', coalesce(g.changed_at > x.at, false),
          'bought', x.bought, 'amount', x.amount,
          'shares', case when x.amount is null then '[]'::jsonb else
              (select jsonb_agg(jsonb_build_object('name', m.name, 'amount', s.amount, 'mine', m.id = me.id) order by s.created_at)
                 from public.noel_shares s join public.noel_members m on m.id = s.member_id where s.gift_id = g.id) end)
        order by o.name, x.at)
        from (select c.gift_id, c.claimed_at as at, c.bought, null::numeric as amount from public.noel_claims c where c.member_id = me.id
              union all
              select s.gift_id, s.created_at, false, s.amount from public.noel_shares s where s.member_id = me.id) x
        join public.noel_gifts g on g.id = x.gift_id
        join public.noel_members o on o.id = g.owner_id
       where g.owner_id <> me.id), '[]'::jsonb));
end $$;

-- Réglages de visibilité de tous les comptes (administrateur seulement)
create or replace function public.noel_admin_views(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  return jsonb_build_object('members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'hasList', m.has_list, 'seesAll', m.sees_all,
      'sees', coalesce((select jsonb_agg(v.owner_id order by v.owner_id) from public.noel_member_sees v where v.member_id = m.id), '[]'::jsonb)))
    from public.noel_members m where m.removed_at is null), '[]'::jsonb));
end $$;

-- A une liste ou non ; voit toutes les listes de ses groupes ou seulement p_sees (administrateur seulement)
create or replace function public.noel_admin_member_view(p_token text, p_member bigint, p_has_list boolean, p_sees_all boolean, p_sees bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.noel_is_admin(p_token) then return jsonb_build_object('error', 'denied'); end if;
  if p_has_list is null or p_sees_all is null or cardinality(coalesce(p_sees, '{}')) > 200
     or not exists (select 1 from public.noel_members where id = p_member and removed_at is null) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.noel_members set has_list = p_has_list, sees_all = p_sees_all where id = p_member;
  delete from public.noel_member_sees where member_id = p_member and not (owner_id = any(coalesce(p_sees, '{}')));
  insert into public.noel_member_sees(member_id, owner_id)
    select p_member, o.id from public.noel_members o where o.id = any(coalesce(p_sees, '{}')) and o.id <> p_member
    on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.noel_admin_views(text), public.noel_admin_member_view(text,bigint,boolean,boolean,bigint[]) from public;
grant execute on function public.noel_admin_views(text), public.noel_admin_member_view(text,bigint,boolean,boolean,bigint[]) to anon, authenticated;

notify pgrst, 'reload schema';
