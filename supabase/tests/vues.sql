-- Essai de la migration 2026-12-03-noel-vues sur une COPIE jetable (jamais sur la base de production).
-- psql -U postgres -d noel_essai -v ON_ERROR_STOP=1 -f vues.sql
reset role;
do $$
declare g bigint; a bigint; b bigint; c bigint; d bigint; adm bigint; ta text; tc text; tadm text; gd bigint; h jsonb; ids bigint[];
begin
  insert into noel_groups(name) values ('Essai vues') returning id into g;
  insert into noel_members(name, login) values ('Essai A', 'essai-a') returning id into a;
  insert into noel_members(name, login) values ('Essai B', 'essai-b') returning id into b;
  insert into noel_members(name, login) values ('Essai C', 'essai-c') returning id into c;
  insert into noel_members(name, login) values ('Essai D', 'essai-d') returning id into d;
  insert into noel_group_members(group_id, member_id) select g, x from unnest(array[a, b, c, d]) x;
  insert into noel_gifts(owner_id, title) values (d, 'Cadeau de D') returning id into gd;
  ta := noel_new_session(a); tc := noel_new_session(c);
  select id into adm from noel_members where is_admin and removed_at is null order by id limit 1;
  tadm := noel_new_session(adm);

  -- Par défaut : A voit B, C, D
  h := noel_home(ta);
  select array_agg((m->>'id')::bigint) into ids from jsonb_array_elements(h->'groups') gr, jsonb_array_elements(gr->'members') m;
  assert ids @> array[b, c, d], 'par défaut A doit voir B, C, D';

  -- C sans liste : invisible pour A, sa liste refusée ; C voit toujours les autres et « hasList » faux
  assert noel_admin_member_view(tadm, c, false, true, '{}')->>'ok' = 'true';
  h := noel_home(ta);
  select coalesce(array_agg((m->>'id')::bigint), '{}') into ids from jsonb_array_elements(h->'groups') gr, jsonb_array_elements(gr->'members') m;
  assert not (c = any(ids)), 'C sans liste ne doit pas apparaître';
  assert noel_list(ta, c)->>'error' = 'denied', 'liste de C sans liste ouverte';
  h := noel_home(tc);
  assert (h->'me'->>'hasList') = 'false', 'hasList faux attendu';
  select array_agg((m->>'id')::bigint) into ids from jsonb_array_elements(h->'groups') gr, jsonb_array_elements(gr->'members') m;
  assert ids @> array[a, b, d], 'C doit voir A, B, D';
  assert noel_list(tc, d)->>'error' is null, 'C doit ouvrir la liste de D';

  -- A ne voit que B : D disparaît, sa liste et la prise de son cadeau sont refusées
  assert noel_admin_member_view(tadm, a, true, false, array[b])->>'ok' = 'true';
  h := noel_home(ta);
  select coalesce(array_agg((m->>'id')::bigint), '{}') into ids from jsonb_array_elements(h->'groups') gr, jsonb_array_elements(gr->'members') m;
  assert ids = array[b], 'A ne doit voir que B, vu : ' || ids::text;
  assert noel_list(ta, d)->>'error' = 'denied', 'liste de D ouverte à A';
  assert noel_take(ta, gd)->>'error' is not null, 'A a pu prendre un cadeau de D';
  assert noel_take(tc, gd)->>'ok' = 'true', 'C doit pouvoir prendre le cadeau de D';

  -- Réglages relus, refus pour un non-administrateur, liste cochée hors groupe sans effet
  assert (select v->'sees' from jsonb_array_elements(noel_admin_views(tadm)->'members') v where (v->>'id')::bigint = a) = jsonb_build_array(b), 'sees relu';
  assert noel_admin_member_view(ta, a, true, true, '{}')->>'error' = 'denied', 'non-administrateur accepté';
  assert noel_admin_views(ta)->>'error' = 'denied', 'non-administrateur lit les réglages';
  -- Tout revenir à « toutes » : la case est retirée et journalisée
  assert noel_admin_member_view(tadm, a, true, true, '{}')->>'ok' = 'true';
  assert not exists (select 1 from noel_member_sees where member_id = a), 'case non retirée';
  assert exists (select 1 from noel_journal where tbl = 'noel_member_sees' and op = 'delete'), 'retrait non journalisé';
  assert exists (select 1 from noel_journal where tbl = 'noel_members' and data->>'id' = c::text and (data->>'has_list')::boolean), 'changement de has_list non journalisé';
  raise notice 'vues : sans liste, restriction, refus, journal OK';
end $$;
set role anon;
do $$
begin
  begin perform 1 from noel_member_sees limit 1; raise exception 'TABLE OUVERTE';
  exception when insufficient_privilege then null; end;
  raise notice 'anon : noel_member_sees fermée';
end $$;
reset role;
