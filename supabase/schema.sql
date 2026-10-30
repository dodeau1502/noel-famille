-- Etat actuel complet de la base (Supabase, projet pegojglksepcfvispcrs).
-- A garder synchronise avec la base : toute modification passe par une migration Supabase
-- PUIS par une mise a jour de ce fichier.
--
-- Principe de confidentialite (NE JAMAIS CASSER) :
--   * aucune table n'est lisible ni modifiable directement depuis l'API publique (RLS sans policy + revoke)
--   * tout passe par des fonctions security definer qui verifient un code (proprietaire ou famille)
--   * noel_get() ne renvoie JAMAIS claimed_by au proprietaire

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
  image_url text check (image_url is null or (char_length(image_url) <= 1000 and image_url ~ '^https://')),
  price numeric(10,2) check (price is null or (price >= 0 and price < 100000)),
  store text check (store is null or char_length(store) <= 80),
  -- offres chez plusieurs marchands : [{"store":"Amazon.fr","price":299,"url":"https://..."}], triées par prix
  offers jsonb check (offers is null or (jsonb_typeof(offers) = 'array' and jsonb_array_length(offers) <= 8)),
  offers_at timestamptz
);

create table public.noel_claims (
  gift_id bigint primary key references public.noel_gifts(id) on delete cascade,
  claimed_by text not null check (char_length(claimed_by) between 1 and 40),
  claimed_at timestamptz not null default now()
);

alter table public.noel_config enable row level security;
alter table public.noel_gifts  enable row level security;
alter table public.noel_claims enable row level security;
revoke all on public.noel_config, public.noel_gifts, public.noel_claims from anon, authenticated;

create or replace function public.noel_role(p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare c public.noel_config;
begin
  select * into c from public.noel_config where id = 1;
  if c.owner_hash = crypt(p_code, c.owner_hash) then return 'owner'; end if;
  if c.family_hash = crypt(p_code, c.family_hash) then return 'family'; end if;
  return null;
end $$;
revoke all on function public.noel_role(text) from public, anon, authenticated;

create or replace function public.noel_get(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r text := public.noel_role(p_code); t text; res jsonb;
begin
  if r is null then raise exception 'code invalide'; end if;
  select title into t from public.noel_config where id = 1;
  select coalesce(jsonb_agg(
    case when r = 'owner'
      then jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                              'image', g.image_url, 'price', g.price, 'store', g.store,
                              'offers', g.offers, 'offers_at', g.offers_at)
      else jsonb_build_object('id', g.id, 'title', g.title, 'url', g.url, 'note', g.note,
                              'image', g.image_url, 'price', g.price, 'store', g.store,
                              'offers', g.offers, 'offers_at', g.offers_at,
                              'claimed_by', c.claimed_by)
    end order by g.created_at), '[]'::jsonb)
  into res
  from public.noel_gifts g left join public.noel_claims c on c.gift_id = g.id;
  return jsonb_build_object('role', r, 'title', t, 'gifts', res);
end $$;

create or replace function public.noel_add(p_code text, p_title text, p_url text, p_note text, p_image text, p_price numeric, p_store text, p_offers jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.noel_role(p_code) is distinct from 'owner' then raise exception 'non autorisé'; end if;
  insert into public.noel_gifts(title, url, note, image_url, price, store, offers, offers_at)
  values (trim(p_title), nullif(trim(p_url), ''), nullif(trim(p_note), ''),
          nullif(trim(p_image), ''), p_price, nullif(trim(p_store), ''),
          case when p_offers is not null and jsonb_typeof(p_offers) = 'array' and jsonb_array_length(p_offers) > 0 then p_offers end,
          case when p_offers is not null and jsonb_typeof(p_offers) = 'array' and jsonb_array_length(p_offers) > 0 then now() end);
end $$;

create or replace function public.noel_remove(p_code text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.noel_role(p_code) is distinct from 'owner' then raise exception 'non autorisé'; end if;
  delete from public.noel_gifts where id = p_id;
end $$;

create or replace function public.noel_claim(p_code text, p_id bigint, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.noel_role(p_code) is distinct from 'family' then raise exception 'non autorisé'; end if;
  insert into public.noel_claims(gift_id, claimed_by) values (p_id, trim(p_name));
exception when unique_violation then
  raise exception 'déjà pris par quelqu''un d''autre';
end $$;

create or replace function public.noel_unclaim(p_code text, p_id bigint, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.noel_role(p_code) is distinct from 'family' then raise exception 'non autorisé'; end if;
  delete from public.noel_claims where gift_id = p_id and lower(claimed_by) = lower(trim(p_name));
end $$;

revoke all on function public.noel_get(text), public.noel_add(text,text,text,text,text,numeric,text,jsonb),
  public.noel_remove(text,bigint), public.noel_claim(text,bigint,text), public.noel_unclaim(text,bigint,text) from public;
grant execute on function public.noel_get(text), public.noel_add(text,text,text,text,text,numeric,text,jsonb),
  public.noel_remove(text,bigint), public.noel_claim(text,bigint,text), public.noel_unclaim(text,bigint,text) to anon, authenticated;

-- Les deux codes d'acces ne sont JAMAIS stockes dans ce depot. Initialisation (a lancer une seule fois) :
-- insert into public.noel_config(title, owner_hash, family_hash)
-- values ('Liste de Noël de ...',
--         extensions.crypt('<code proprietaire>', extensions.gen_salt('bf')),
--         extensions.crypt('<code famille>',      extensions.gen_salt('bf')));
