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
