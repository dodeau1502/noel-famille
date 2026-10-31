-- Liste de Noël famille : état actuel complet de la base (v4)
-- Les tables ne sont lisibles par personne via l'API ; tout passe par des fonctions
-- qui vérifient un code (propriétaire ou famille). Le propriétaire ne reçoit
-- jamais les informations de réservation (claimed_by, bought, paid).
-- Convention : les fonctions API renvoient du jsonb {"ok":true} ou {"error":"denied|throttled|taken|short|same_as_owner|empty"}
-- au lieu de lever une exception (sinon l'enregistrement des essais ratés serait annulé).

create extension if not exists pgcrypto with schema extensions;

create table public.noel_config (
  id int primary key default 1 check (id = 1),
  title text not null default 'Ma liste de Noël',
  owner_hash text not null,
  family_hash text not null
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
  gtin text check (gtin is null or gtin ~ '^[0-9]{8,14}$'),   -- code-barres lu sur la page collée
  checked_at timestamptz                                       -- dernière relecture des pages des marchands
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
-- Aucune policy : aucun accès direct via l'API publique.
revoke all on public.noel_config, public.noel_gifts, public.noel_claims, public.noel_attempts, public.noel_prices from anon, authenticated;

create or replace function public.noel_client_ip()
returns text language sql stable set search_path = public as $$
  select coalesce(
    nullif(nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip', ''),
    nullif(trim(regexp_replace(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), '^.*,', '')), ''),
    'inconnu')
$$;

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
declare r text := public.noel_role(p_code); t text; res jsonb;
begin
  if r is null or r = 'throttled' then return public.noel_deny(r); end if;
  select title into t from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                       'image', g.image_url, 'price', g.price, 'store', g.store,
                       'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top,
                       'gtin', g.gtin, 'checked_at', g.checked_at,
                       'history', coalesce((select jsonb_agg(jsonb_build_object('d', to_char(h.at at time zone 'Europe/Paris', 'YYYY-MM-DD'), 'p', h.price, 'v', h.verified) order by h.at)
                                              from (select * from public.noel_prices x where x.gift_id = g.id order by x.at desc limit 60) h), '[]'::jsonb))
    || case when r = 'owner' then '{}'::jsonb
            else jsonb_build_object('claimed_by', c.claimed_by, 'bought', coalesce(c.bought, false), 'paid', c.paid) end
    order by g.created_at), '[]'::jsonb)
  into res
  from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id;
  return jsonb_build_object('role', r, 'title', t, 'gifts', res);
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
  public.noel_set_paid(text,bigint,text,numeric)
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
  public.noel_set_paid(text,bigint,text,numeric)
to anon, authenticated;

-- Initialisation (remplacer les deux codes par des phrases longues, différentes l'une de l'autre).
-- Ne jamais écrire les vrais codes dans le dépôt :
-- insert into public.noel_config(title, owner_hash, family_hash)
-- values ('Liste de Noël de Dorian',
--         extensions.crypt('CODE_PROPRIETAIRE', extensions.gen_salt('bf')),
--         extensions.crypt('CODE_FAMILLE',      extensions.gen_salt('bf')));

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
