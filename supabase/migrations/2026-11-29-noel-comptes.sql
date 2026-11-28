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
