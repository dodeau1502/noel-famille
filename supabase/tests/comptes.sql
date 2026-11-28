-- Essai des comptes et des listes. SUR UNE COPIE JETABLE nommée « noel_essai » seulement (le script change le code propriétaire).
-- Restaurer un pg_dump -Fc dans noel_essai, y appliquer les migrations et deploy/db/03-droits.sql, puis : psql -d noel_essai -f ce_fichier
\set ON_ERROR_STOP 1
do $$ begin if current_database() <> 'noel_essai' then raise exception 'réservé à la copie noel_essai'; end if; end $$;
-- Copie jetable : code propriétaire d'essai et anciennes réservations inventées
update public.noel_config set owner_hash = extensions.crypt('essai-proprio', extensions.gen_salt('bf'));
insert into public.noel_gifts(title) values ('Cadeau ancien deux');
insert into public.noel_claims(gift_id, claimed_by) select min(id), 'Julie' from public.noel_gifts;
insert into public.noel_claims(gift_id, claimed_by) select max(id), '0123456789abcdef' from public.noel_gifts;
set role anon;
do $$
declare r jsonb; a text; j text; p text; z text; aid bigint; jid bigint; pid bigint; zid bigint; g1 bigint; g2 bigint; grp bigint; autre bigint; gj bigint; n int;
begin
  r := noel_setup('mauvais', 'Chef', 'chef'); assert r->>'error' = 'denied', 'setup mauvais code';
  r := noel_setup('essai-proprio', 'Chef', 'chef'); assert r ? 'invite', 'setup ' || r;
  r := noel_activate(r->>'invite', '1111'); a := r->>'token'; assert a is not null, 'activation chef';
  r := noel_home(a); aid := (r->'me'->>'id')::bigint; assert (r->'me'->>'count')::int >= 2, 'cadeaux donnés au chef';
  r := noel_admin(a); grp := (r->'groups'->0->>'id')::bigint;
  r := noel_admin_member_add(a, 'Julie', 'Julie', array[grp]); assert r->>'login' = 'julie', 'ajout Julie ' || r;
  j := noel_activate(r->>'invite', '2222')->>'token';
  r := noel_admin_member_add(a, 'Paul', 'paul', array[grp]); p := noel_activate(r->>'invite', '3333')->>'token';
  perform noel_admin_group_add(a, 'Belle-famille');
  select (x->>'id')::bigint into autre from jsonb_array_elements(noel_admin(a)->'groups') x where x->>'name' = 'Belle-famille';
  r := noel_admin_member_add(a, 'Zoé', 'Zoé', array[autre]); z := noel_activate(r->>'invite', '4444')->>'token';
  assert noel_admin_member_add(a, 'Autre', 'zoe', '{}')->>'error' = 'exists', 'identifiant en double';
  jid := (noel_home(j)->'me'->>'id')::bigint; pid := (noel_home(p)->'me'->>'id')::bigint; zid := (noel_home(z)->'me'->>'id')::bigint;

  -- Ancienne réservation « Julie » rattachée ; la réservation anonyme reste sans nom
  r := noel_list(j, aid); assert (r->'gifts'->0->>'mine')::boolean and r->'gifts'->0->>'by' = 'Julie', 'rattachement ' || r;
  assert (r->'gifts'->1->>'taken')::boolean and r->'gifts'->1->>'by' is null, 'anonyme';
  -- Règle 1 : rien sur sa propre liste
  r := noel_list(a, aid); assert (r->>'mine')::boolean and not (r->'gifts'->0 ?| array['taken','mine','by','shares','bought']), 'fuite propre liste ' || r;
  assert noel_home(a)->'offering' = '[]'::jsonb, 'fuite offering';
  -- Cloisonnement des groupes
  assert noel_list(z, jid)->>'error' = 'denied', 'groupe cloisonné';
  -- L'administrateur remplit la liste d'un autre, même d'un autre groupe ; personne d'autre ne le peut
  assert noel_gift_save(a, null, 'Pour Zoé', null, null, null, null, null, null, null, false, zid) ? 'ok', 'admin ajoute';
  r := noel_list(z, zid); assert r->'gifts'->0->>'title' = 'Pour Zoé' and not (r->'gifts'->0 ? 'taken'), 'visible par la personne';
  r := noel_list(a, zid); assert r->'gifts'->0 ? 'taken', 'admin voit la liste';
  assert noel_gift_save(a, (r->'gifts'->0->>'id')::bigint, 'Corrigé', null, 'S', null, null, null, null, null, false) ? 'ok', 'admin modifie';
  assert noel_list(z, zid)->'gifts'->0->>'size' = 'S', 'modification vue';
  assert noel_gift_save(j, null, 'Pirate', null, null, null, null, null, null, null, false, zid)->>'error' = 'denied', 'ajout chez un autre refusé';
  assert noel_gift_save(j, (r->'gifts'->0->>'id')::bigint, 'Pirate', null, null, null, null, null, null, null, false)->>'error' = 'denied', 'modif refusée';
  assert noel_gift_delete(j, (r->'gifts'->0->>'id')::bigint)->>'error' = 'denied', 'retrait refusé';
  assert noel_take(a, (r->'gifts'->0->>'id')::bigint) ? 'ok', 'admin peut offrir';
  assert not (noel_list(z, zid)->'gifts'->0 ?| array['taken','by','mine','shares']), 'fuite chez Zoé';
  assert noel_gift_delete(a, (r->'gifts'->0->>'id')::bigint) ? 'ok', 'admin retire';
  assert noel_release(a, (r->'gifts'->0->>'id')::bigint) ? 'ok', 'admin annule';
  assert noel_admin(j)->>'error' = 'denied', 'admin réservé';

  -- Listes, liens longs, tailles
  assert noel_gift_save(j, null, 'Pull', 'https://exemple.test/' || repeat('a', 900), 'M', 'Vert', 'laine', null, 45, 'Magasin', true) ? 'ok', 'ajout';
  assert noel_gift_save(j, null, 'Vélo', null, '8 ans', null, null, null, 150, null, false) ? 'ok', 'ajout 2';
  r := noel_list(p, jid); g1 := (r->'gifts'->0->>'id')::bigint; g2 := (r->'gifts'->1->>'id')::bigint; assert r->'gifts'->0->>'size' = 'M', 'taille';
  assert noel_gift_save(p, g1, 'Pirate', null, null, null, null, null, null, null, false)->>'error' = 'denied', 'modifier chez un autre';
  assert noel_gift_delete(p, g1)->>'error' = 'denied', 'retirer chez un autre';

  -- Prendre et participer
  assert noel_take(j, g1)->>'error' = 'denied' and noel_share(j, g2, 10)->>'error' = 'denied', 'sur sa liste';
  assert noel_take(p, g1) ? 'ok', 'prendre';
  assert noel_take(a, g1)->>'error' = 'taken' and noel_share(a, g1, 10)->>'error' = 'taken', 'déjà pris';
  assert noel_share(p, g2, 30) ? 'ok' and noel_share(a, g2, 50) ? 'ok' and noel_share(p, g2, 40) ? 'ok', 'participations';
  assert noel_take(a, g2)->>'error' = 'shared', 'prise seule après participations';
  assert noel_share(p, g2, 0)->>'error' = 'invalid', 'montant nul';
  r := noel_list(a, jid); assert jsonb_array_length(r->'gifts'->1->'shares') = 2, 'parts visibles';
  r := noel_list(j, jid); assert not (r->'gifts'->1 ? 'shares') and r::text not like '%Paul%', 'fuite participations ' || r;
  r := noel_home(p); assert jsonb_array_length(r->'offering') = 2, 'ce que j''offre ' || r;
  r := noel_home(j)->'offering'; assert jsonb_array_length(r) = 1 and r->0->>'ownerName' = 'Chef', 'Julie : seulement son ancienne reservation ' || r;

  -- Code faux : blocage après 5 essais
  for n in 1..5 loop assert noel_login('paul', '0000')->>'error' = 'denied', 'faux ' || n; end loop;
  assert noel_login('paul', '3333')->>'error' = 'locked', 'blocage';

  -- Réinitialisation par l'administrateur
  assert noel_admin_reset(j, pid)->>'error' = 'denied' and noel_admin_reset(a, aid)->>'error' = 'denied', 'reset réservé';
  assert noel_admin_reset(a, pid) ? 'ok', 'reset';
  assert noel_home(p)->>'error' = 'session', 'session coupée';
  assert (noel_login('Paul', '')->>'reset')::boolean, 'reset proposé';
  assert noel_admin_invite(a, pid)->>'error' = 'denied', 'pas de lien pendant reset';
  p := noel_reset_choose('paul', '5555')->>'token'; assert p is not null, 'nouveau code';
  assert noel_reset_choose('paul', '6666')->>'error' = 'denied', 'usage unique';
  assert noel_login('paul', '5555') ? 'token' and jsonb_array_length(noel_home(p)->'offering') = 2, 'réservations gardées';
  assert noel_login('julie', '')->>'error' = 'pin', 'code vide';
  assert noel_change_pin(j, '0000', '7777')->>'error' = 'oldpin' and noel_change_pin(j, '2222', '7777') ? 'ok', 'changer';

  perform set_config('essai.a', a, false); perform set_config('essai.j', j, false); perform set_config('essai.p', p, false);
  perform set_config('essai.jid', jid::text, false); perform set_config('essai.g1', g1::text, false); perform set_config('essai.g2', g2::text, false);
  raise notice 'partie 1 : OK';
end $$;
do $$
declare p text := current_setting('essai.p'); j text := current_setting('essai.j'); a text := current_setting('essai.a');
        g1 bigint := current_setting('essai.g1'); g2 bigint := current_setting('essai.g2'); r jsonb;
begin
  -- Modification et retrait après réservation (transaction distincte : les dates diffèrent)
  assert noel_gift_save(j, g1, 'Pull', null, 'L', 'Vert', 'laine', null, 45, null, true) ? 'ok', 'modifier';
  assert noel_gift_delete(j, g2) ? 'ok', 'retirer';
  r := noel_home(p)->'offering';
  assert (select bool_or((x->>'changed')::boolean) and bool_or((x->>'removed')::boolean) from jsonb_array_elements(r) x), 'alertes ' || r;
  assert jsonb_array_length(noel_list(j, current_setting('essai.jid')::bigint)->'gifts') = 1, 'retiré masqué';
  assert noel_release(p, g1) ? 'ok' and noel_release(p, g2) ? 'ok' and noel_release(a, g2) ? 'ok', 'annuler';
  assert noel_home(p)->'offering' = '[]'::jsonb, 'vide';
  r := noel_logout(p); assert noel_home(p)->>'error' = 'session', 'déconnexion';
  -- Administrateur qui a oublié son code
  r := noel_setup('essai-proprio', 'x', 'xx'); assert r ? 'invite' and noel_home(a)->>'error' = 'session', 'récupération';
  assert noel_activate(r->>'invite', '8888') ? 'token', 'réactivation';
  raise notice 'partie 2 : OK';
end $$;
-- Rien ne se perd : corbeille, compte supprimé puis restauré
do $$
declare a text; j text; r jsonb; jid bigint; pid bigint; gid bigint; grp bigint;
begin
  r := noel_setup('essai-proprio', 'x', 'xx'); a := noel_activate(r->>'invite', '9999')->>'token';
  r := noel_admin(a); grp := (select (x->>'id')::bigint from jsonb_array_elements(r->'groups') x where x->>'name' = 'Famille');
  r := noel_admin_member_add(a, 'Nina', 'nina', array[grp]); j := noel_activate(r->>'invite', '1212')->>'token';
  r := noel_home(j); jid := (r->'me'->>'id')::bigint;
  perform noel_gift_save(j, null, 'Précieux', null, null, null, null, null, null, null, false);
  gid := (noel_list(j, jid)->'gifts'->0->>'id')::bigint;
  assert noel_take(a, gid) ? 'ok', 'pris';
  assert noel_gift_delete(j, gid) ? 'ok', 'retiré';
  r := noel_trash(j, jid); assert r->'gifts'->0->>'title' = 'Précieux' and not (r->'gifts'->0 ?| array['taken','by','mine','bought']), 'corbeille ' || r;
  assert noel_gift_restore(j, gid) ? 'ok' and noel_trash(j, jid) is not null, 'remis';
  assert noel_list(a, jid)->'gifts'->0->>'by' is not null, 'réservation gardée';
  assert noel_trash(j, (noel_home(a)->'me'->>'id')::bigint)->>'error' = 'denied', 'corbeille des autres fermée';
  -- la personne offre un cadeau, puis son compte est supprimé et restauré
  perform noel_gift_save(a, null, 'Du chef', null, null, null, null, null, null, null, false);
  pid := (select (x->>'id')::bigint from jsonb_array_elements(noel_list(j, (noel_home(a)->'me'->>'id')::bigint)->'gifts') x where x->>'title' = 'Du chef');
  assert noel_take(j, pid) ? 'ok', 'Nina offre';
  perform set_config('essai.a', a, false); perform set_config('essai.j', j, false); perform set_config('essai.jid', jid::text, false);
end $$;
do $$
declare a text := current_setting('essai.a'); j text := current_setting('essai.j'); jid bigint := current_setting('essai.jid'); r jsonb;
begin
  assert noel_admin_member_remove(j, jid)->>'error' = 'denied', 'suppression réservée';
  assert noel_admin_member_remove(a, jid) ? 'ok', 'supprimé';
  assert noel_home(j)->>'error' = 'session' and noel_login('nina', '1212')->>'error' = 'denied', 'plus d''accès';
  r := noel_admin(a); assert r->'removed'->0->>'name' = 'Nina' and r::text not like '%"login": "nina"%', 'listé comme supprimé';
  assert noel_admin_invite(a, jid)->>'error' = 'denied', 'pas de lien';
  perform set_config('essai.a', a, false);
end $$;
do $$
declare a text := current_setting('essai.a'); jid bigint := current_setting('essai.jid'); r jsonb;
begin
  assert noel_admin_member_restore(a, jid) ? 'ok', 'restauré';
  r := noel_list(a, jid); assert jsonb_array_length(r->'gifts') = 1 and r->'gifts'->0->>'title' = 'Précieux', 'liste intacte';
  r := noel_admin(a); assert (select jsonb_array_length(x->'groups') = 1 from jsonb_array_elements(r->'members') x where (x->>'id')::bigint = jid), 'groupe revenu';
  assert noel_admin_reset(a, jid) ? 'ok' and (noel_login('nina', '')->>'reset')::boolean, 'nouveau code possible';
  assert noel_reset_choose('nina', '3434') ? 'token', 'reconnexion';
  raise notice 'partie 3 : OK';
end $$;
do $$
declare a text := current_setting('essai.a'); r jsonb; grp bigint; n int;
begin
  r := noel_admin(a); grp := (select (x->>'id')::bigint from jsonb_array_elements(r->'groups') x where x->>'name' = 'Famille');
  select count(*) into n from jsonb_array_elements(r->'members') x where x->'groups' @> to_jsonb(grp);
  assert noel_admin_group_remove(a, grp) ? 'ok', 'groupe supprimé';
  perform set_config('essai.grp', grp::text, false); perform set_config('essai.n', n::text, false);
end $$;
do $$
declare a text := current_setting('essai.a'); grp bigint := current_setting('essai.grp'); n int := current_setting('essai.n'); r jsonb; m int;
begin
  r := noel_admin(a); assert r->'removedGroups'->0->>'name' = 'Famille', 'listé ' || r;
  assert noel_admin_group_restore(a, (r->'removedGroups'->0->>'entry')::bigint) ? 'ok', 'groupe restauré';
  r := noel_admin(a);
  select count(*) into m from jsonb_array_elements(r->'members') x where x->'groups' @> to_jsonb(grp);
  assert m = n and n > 1 and r->'removedGroups' = '[]'::jsonb, format('membres %s sur %s', m, n);
  raise notice 'partie 4 : OK';
end $$;
reset role;
do $$
declare n int := 0; q text;
begin
  assert (select count(*) from noel_claims where member_id = current_setting('essai.jid')::bigint) = 1, 'sa réservation est revenue';
  assert (select count(*) from noel_journal) > 5, 'journal rempli';
  assert not exists (select 1 from noel_journal where data ? 'pin_hash'), 'pas d''empreinte de code au journal';
  foreach q in array array['delete from noel_gifts', 'delete from noel_members', 'truncate noel_claims', 'truncate noel_gifts cascade'] loop
    begin execute q; raise exception 'SUPPRESSION POSSIBLE : %', q;
    exception when raise_exception then if sqlerrm like 'SUPPRESSION POSSIBLE%' then raise; end if; n := n + 1; end;
  end loop;
  raise notice 'suppressions bloquées : % sur 4', n;
end $$;
set role anon;
-- Anciennes fonctions et tables fermées
do $$
declare q text; n int := 0;
begin
  foreach q in array array['select noel_public()', 'select noel_get(''essai-proprio'')', 'select noel_claim(''x'',1,''y'')', 'select noel_auth(''x'')',
                          'select noel_new_session(1)', 'select * from noel_claims', 'select * from noel_journal', 'select * from noel_shares', 'select * from noel_members', 'select * from noel_sessions'] loop
    begin execute q; raise exception 'ACCES OUVERT : %', q;
    exception when insufficient_privilege then n := n + 1; end;
  end loop;
  raise notice 'fermetures : % sur 10', n;
end $$;
