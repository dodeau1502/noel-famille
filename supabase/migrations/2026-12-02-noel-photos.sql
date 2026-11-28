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
