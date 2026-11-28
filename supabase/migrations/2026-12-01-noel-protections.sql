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

notify pgrst, 'reload schema';
