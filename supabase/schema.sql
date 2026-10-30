-- Liste de Noël famille : état actuel complet de la base (v3)
-- Les tables ne sont lisibles par personne via l'API ; tout passe par des fonctions
-- qui vérifient un code (propriétaire ou famille). Le propriétaire ne reçoit
-- jamais les informations de réservation (claimed_by, bought).
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
  top boolean not null default false
);

create table public.noel_claims (
  gift_id bigint primary key references public.noel_gifts(id) on delete cascade,
  claimed_by text not null check (char_length(claimed_by) between 1 and 40),
  claimed_at timestamptz not null default now(),
  bought boolean not null default false
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
-- Aucune policy : aucun accès direct via l'API publique.
revoke all on public.noel_config, public.noel_gifts, public.noel_claims, public.noel_attempts from anon, authenticated;

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
    case when r = 'owner'
      then jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                              'image', g.image_url, 'price', g.price, 'store', g.store,
                              'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top)
      else jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                              'image', g.image_url, 'price', g.price, 'store', g.store,
                              'offers', g.offers, 'offers_at', g.offers_at, 'top', g.top,
                              'claimed_by', c.claimed_by, 'bought', coalesce(c.bought, false))
    end order by g.created_at), '[]'::jsonb)
  into res
  from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id;
  return jsonb_build_object('role', r, 'title', t, 'gifts', res);
end $$;

create or replace function public.noel_add(p_code text, p_title text, p_url text, p_note text, p_image text,
                                           p_price numeric, p_store text, p_offers jsonb, p_top boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code);
begin
  if r is distinct from 'owner' then return public.noel_deny(r); end if;
  insert into public.noel_gifts(title, url, note, image_url, price, store, offers, offers_at, top)
  values (trim(p_title), nullif(trim(p_url), ''), nullif(trim(p_note), ''),
          nullif(trim(p_image), ''), p_price, nullif(trim(p_store), ''),
          case when p_offers is not null and jsonb_typeof(p_offers) = 'array' and jsonb_array_length(p_offers) > 0 then p_offers end,
          case when p_offers is not null and jsonb_typeof(p_offers) = 'array' and jsonb_array_length(p_offers) > 0 then now() end,
          coalesce(p_top, false));
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
     set price = p_price, store = nullif(trim(p_store), ''), offers = p_offers, offers_at = now()
   where id = p_id;
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

-- Fonctions internes : jamais appelables depuis l'API publique
revoke all on function public.noel_role(text), public.noel_deny(text), public.noel_client_ip() from public, anon, authenticated;

-- Fonctions de l'API
revoke all on function
  public.noel_get(text),
  public.noel_add(text,text,text,text,text,numeric,text,jsonb,boolean),
  public.noel_remove(text,bigint),
  public.noel_set_top(text,bigint,boolean),
  public.noel_set_offers(text,bigint,numeric,text,jsonb),
  public.noel_set_family_code(text,text),
  public.noel_claim(text,bigint,text),
  public.noel_unclaim(text,bigint,text),
  public.noel_set_bought(text,bigint,text,boolean)
from public;
grant execute on function
  public.noel_get(text),
  public.noel_add(text,text,text,text,text,numeric,text,jsonb,boolean),
  public.noel_remove(text,bigint),
  public.noel_set_top(text,bigint,boolean),
  public.noel_set_offers(text,bigint,numeric,text,jsonb),
  public.noel_set_family_code(text,text),
  public.noel_claim(text,bigint,text),
  public.noel_unclaim(text,bigint,text),
  public.noel_set_bought(text,bigint,text,boolean)
to anon, authenticated;

-- Initialisation (remplacer les deux codes par des phrases longues, différentes l'une de l'autre).
-- Ne jamais écrire les vrais codes dans le dépôt :
-- insert into public.noel_config(title, owner_hash, family_hash)
-- values ('Liste de Noël de Dorian',
--         extensions.crypt('CODE_PROPRIETAIRE', extensions.gen_salt('bf')),
--         extensions.crypt('CODE_FAMILLE',      extensions.gen_salt('bf')));
