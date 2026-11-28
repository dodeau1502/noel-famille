-- 4 décembre 2026 : profil (demande de Dorian) : chacun change son prénom affiché (PAS son identifiant) et met sa photo.
-- À appliquer en tant que noel_owner (`set role noel_owner;`, psql --single-transaction), après un pg_dump -Fc, d'abord sur une copie.
--
-- La photo de profil est une ligne de noel_photos (déjà réduite par la page, envoyée avec noel_photo_add). Rien n'est effacé :
-- « retirer » met la colonne à null. Aucun lien avec les réservations (règle 1) ; noel_home et noel_list ne changent pas.

alter table public.noel_members add column photo text references public.noel_photos(id);

-- Le journal des comptes garde aussi la photo d'avant
drop trigger noel_journal_trg on public.noel_members;
create trigger noel_journal_trg after delete or update of name, login, has_list, sees_all, photo on public.noel_members for each row execute function public.noel_log();

-- Mon profil. p_name null : prénom inchangé. p_photo null : photo inchangée ; '' : retirée ; sinon une photo que J'AI envoyée.
-- Un prénom déjà porté par quelqu'un d'autre est refusé : « Pris par X » doit désigner une seule personne.
create or replace function public.noel_profile_save(p_token text, p_name text default null, p_photo text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
        v_name text := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  if p_name is not null then
    if char_length(v_name) not between 1 and 40 then return jsonb_build_object('error', 'invalid'); end if;
    if exists (select 1 from public.noel_members m where m.id <> me.id and m.removed_at is null
                and lower(m.name) = lower(v_name)) then
      return jsonb_build_object('error', 'nametaken');
    end if;
  end if;
  if coalesce(p_photo, '') <> '' and not exists (select 1 from public.noel_photos p where p.id = p_photo and p.member_id = me.id) then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.noel_members set
    name  = case when p_name is null then name else v_name end,
    photo = case when p_photo is null then photo else nullif(p_photo, '') end
   where id = me.id;
  return jsonb_build_object('ok', true);
end $$;

-- Mon identifiant, et les photos de profil des personnes que je peux voir (la mienne comprise) : {"12":"<id de photo>", …}
create or replace function public.noel_faces(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.noel_members := public.noel_auth(p_token);
begin
  if me.id is null then return jsonb_build_object('error', 'session'); end if;
  return jsonb_build_object('login', me.login, 'faces', coalesce((select jsonb_object_agg(m.id::text, m.photo) from public.noel_members m
    where m.photo is not null and m.removed_at is null and public.noel_sees(me.id, m.id)), '{}'::jsonb));
end $$;

revoke all on function public.noel_profile_save(text,text,text), public.noel_faces(text) from public;
grant execute on function public.noel_profile_save(text,text,text), public.noel_faces(text) to anon, authenticated;

notify pgrst, 'reload schema';
