-- Essai de la migration 2026-12-04-noel-profil sur une COPIE jetable (jamais sur la base de production).
-- psql -U postgres -d noel_essai -v ON_ERROR_STOP=1 -f profil.sql
reset role;
do $$
declare g bigint; a bigint; b bigint; c bigint; ta text; tb text; tc text; r jsonb; pa text; img text;
begin
  insert into noel_groups(name) values ('Essai profil') returning id into g;
  insert into noel_members(name, login) values ('Profil A', 'profil-a') returning id into a;
  insert into noel_members(name, login) values ('Profil B', 'profil-b') returning id into b;
  insert into noel_members(name, login) values ('Profil C', 'profil-c') returning id into c;   -- hors groupe
  insert into noel_group_members(group_id, member_id) values (g, a), (g, b);
  ta := noel_new_session(a); tb := noel_new_session(b); tc := noel_new_session(c);
  img := encode('\xffd8ffe0'::bytea || decode(repeat('00', 200), 'hex'), 'base64');

  -- Prénom : changé, identifiant intact
  assert noel_profile_save(ta, '  Mamie   Jo ')->>'ok' = 'true';
  assert (select name = 'Mamie Jo' and login = 'profil-a' from noel_members where id = a), 'prénom ou identifiant incorrect';
  assert noel_profile_save(ta, '   ')->>'error' = 'invalid', 'prénom vide accepté';
  assert noel_profile_save(ta, repeat('x', 41))->>'error' = 'invalid', 'prénom trop long accepté';
  assert noel_profile_save(ta, 'profil b')->>'error' = 'nametaken', 'prénom déjà pris accepté';
  assert noel_profile_save(ta, 'MAMIE JO')->>'ok' = 'true', 'changer la casse de son prénom refusé';
  assert noel_profile_save('mauvais', 'X')->>'error' = 'session';

  -- Photo : la mienne seulement
  pa := noel_photo_add(ta, img)->>'id';
  assert noel_profile_save(tb, null, pa)->>'error' = 'invalid', 'photo d''une autre personne acceptée';
  assert noel_profile_save(ta, null, 'n-existe-pas')->>'error' = 'invalid';
  assert noel_profile_save(ta, null, pa)->>'ok' = 'true';
  assert (select name from noel_members where id = a) = 'MAMIE JO', 'le prénom ne devait pas changer';
  assert noel_faces(ta)->'faces'->>a::text = pa, 'ma photo absente';
  assert noel_faces(ta)->>'login' = 'profil-a', 'identifiant absent';
  assert noel_faces(tb)->'faces'->>a::text = pa, 'photo absente pour le groupe';
  assert noel_faces(tc)->'faces'->>a::text is null, 'photo visible hors groupe';
  assert noel_faces('mauvais')->>'error' = 'session';

  -- Retrait, et journal de ce qui était avant
  assert noel_profile_save(ta, null, '')->>'ok' = 'true';
  assert (select photo from noel_members where id = a) is null;
  assert exists (select 1 from noel_journal where tbl = 'noel_members' and data->>'photo' = pa), 'photo d''avant absente du journal';
  raise notice 'profil : prénom, photo, visibilité et journal OK';
end $$;
