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
