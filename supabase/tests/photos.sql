-- Essai de la migration 2026-12-02-noel-photos sur une COPIE jetable (jamais sur la base de production).
-- psql -U postgres -d noel_essai -v ON_ERROR_STOP=1 -f photos.sql (après la migration et la ligne noel_photo_get de 03-droits.sql)
reset role;
create temp table essai(k text primary key, v text);
grant all on essai to public;
do $$
declare t text; r jsonb; b text;
begin
  t := noel_new_session((select id from noel_members order by id limit 1));
  b := encode('\xffd8ffe0'::bytea || decode(repeat('00', 200), 'hex'), 'base64');   -- base64 avec retours à la ligne, comme encode() les fait
  r := noel_photo_add(t, b);
  assert r->>'ok' = 'true', 'ajout refusé : ' || r::text;
  assert decode(noel_photo_get(r->>'id'), 'base64') = decode(b, 'base64'), 'photo relue différente';
  insert into essai values ('id', r->>'id'), ('tok', t);
  assert noel_photo_add(t, encode(decode(repeat('00', 200), 'hex'), 'base64'))->>'error' = 'invalid', 'non-JPEG accepté';
  assert noel_photo_add(t, 'pas du base64 !!')->>'error' = 'invalid', 'base64 invalide accepté';
  assert noel_photo_add(t, encode('\xffd8ffe0'::bytea || decode(repeat('00', 400000), 'hex'), 'base64'))->>'error' = 'invalid', 'trop grande acceptée';
  assert noel_photo_add('mauvais', b)->>'error' = 'session', 'sans session acceptée';
  assert noel_photo_get('pas-un-id') is null;
  begin delete from noel_photos; raise exception 'SUPPRESSION POSSIBLE';
  exception when raise_exception then if sqlerrm = 'SUPPRESSION POSSIBLE' then raise; end if; end;
  raise notice 'photos : ajout, relecture, refus et suppression bloquée OK';
end $$;
-- Rôles de l'API publique : ni la table ni la lecture directe
set role anon;
do $$
declare q text; n int := 0;
begin
  foreach q in array array['select * from noel_photos', 'select noel_photo_get(''aaaaaaaaaaaaaaaaaaaaaaaa'')'] loop
    begin execute q; raise exception 'ACCES OUVERT : %', q;
    exception when insufficient_privilege then n := n + 1; end;
  end loop;
  assert (select noel_photo_add('x', 'y'))->>'error' = 'session', 'noel_photo_add doit répondre (fermé par la session seulement)';
  raise notice 'anon : % fermetures sur 2, ajout soumis à la session', n;
end $$;
-- Clé de service : lecture seulement par la fonction
reset role;
set role service_role;
do $$
begin
  assert noel_photo_get((select v from essai where k = 'id')) is not null, 'service_role ne lit pas la photo';
  begin perform 1 from noel_photos limit 1; raise exception 'TABLE OUVERTE A service_role';
  exception when insufficient_privilege then null; end;
  raise notice 'service_role : lecture par la fonction seulement OK';
end $$;
reset role;
