# Runbook : transfert de la Liste de Noël vers le VPS

Aucun secret dans ce fichier. Les mots de passe, clés et chaînes de connexion se saisissent avec `read -rs` ou dans les variables Coolify.
Accès à Supabase conservé intact jusqu'à validation : c'est le retour arrière.

## État au 13 novembre 2026
- Branche `vps-migration` : code prêt (serveur Deno, Dockerfile, compose, scripts SQL). `main` et GitHub Pages non touchés.
- Testé ici : tests node existants, serveur Deno avec faux PostgREST (relais, refus des tables, en-tête `cf-connecting-ip` supprimé, secret du relevé), schéma + rôles + droits dans un moteur Postgres de test (PGlite, pas la version du VPS).
- Non testé (exige le VPS) : PostgREST réel (`noel_client_ip()` lit `request.headers`), Traefik/Coolify, tâche planifiée, copie des données, HTTPS.

## Variables Coolify (service `app` et `postgrest`)
| Variable | Source |
|---|---|
| `JWT_SECRET` | généré sur le VPS (`openssl rand -base64 48`), jamais dans le chat |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | sortie de `deploy/creer-cles.mjs` |
| `NOEL_DB_PASSWORD` | mot de passe du rôle `noel_authenticator` (le même qu'à l'étape A) |
| `POSTGRES_HOST` | nom interne du conteneur PostgreSQL dans Coolify |
| `POSTGREST_VERSION` | tag précis de `postgrest/postgrest` choisi sur la page officielle des versions (non vérifié ici) |
| `SERPAPI_KEY` | nouvelle clé SerpAPI |
| `CRON_SECRET` | `openssl rand -base64 32` |

## A. Base (sur le VPS, terminal du conteneur PostgreSQL ou `docker exec`)
1. `read -rs NOEL_DB_PASSWORD; export NOEL_DB_PASSWORD`
2. `psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v mdp="$NOEL_DB_PASSWORD" -f deploy/db/01-roles-et-base.sql`
3. `psql -U postgres -d noel -v ON_ERROR_STOP=1 -f deploy/db/02-preparation.sql`
4. `read -rs PGURI; export PGURI` (`postgres://postgres:…@hôte:5432/noel`) puis `sh deploy/db/appliquer-schema.sh`
Attendu : « Schéma appliqué. » Retour arrière : `drop database noel;` (rien d'autre n'en dépend).

## B. Données (court gel du site, voir plus bas)
1. Sauvegarde : lancer une sauvegarde Coolify de la base `noel` et la restaurer dans une base de test avant toute bascule.
2. `read -rs SRC; read -rs DST; export SRC DST; sh deploy/db/copier-donnees.sh <version majeure>`
3. Comparer les comptes (sans lire les réservations) : `select count(*) from noel_gifts; select count(*) from noel_claims; select count(*) from noel_prices;` des deux côtés.

## C. Test sur une adresse provisoire (avant toute bascule)
Dans Coolify, déployer la branche `vps-migration` sur une adresse de test (ex. `noel-test.<domaine>`), avec les variables ci-dessus. Contrôles (voir ARCHITECTURE du guide, étape 8) :
- `POST /rest/v1/rpc/noel_get` avec un faux code → `{"error":"denied"}`
- 16 faux codes en 10 minutes → `throttled`, même avec un `cf-connecting-ip` inventé
- `GET /rest/v1/noel_claims` → 403
- `noel-refresh` `{"cron":true}` sans secret → 403
- `noel-preview` sans code propriétaire → 403 ; avec `http://postgrest:3000/` → « Lien non accepté »
- Ouverture avec le code propriétaire : aucune donnée de réservation ; avec le code famille : réservations visibles
- Une vraie recherche SerpAPI avec la nouvelle clé (étape 0 du plan du projet)

## D. Relevé toutes les 2 h
Tâche planifiée Coolify sur le service `app`, `17 */2 * * *`, commande :
`deno eval "await fetch('http://127.0.0.1:8000/functions/v1/noel-refresh',{method:'POST',headers:{'content-type':'application/json','x-cron-secret':Deno.env.get('CRON_SECRET')},body:'{\"cron\":true}'})"`
(Interface et limites des tâches planifiées à vérifier dans la documentation Coolify de votre version.)

## E. Bascule (après validation de C et choix d'une date calme)
1. Gel : ne rien modifier sur le site (~15 min). Recopier les données (B2 sur une base vide : `truncate` des 6 tables d'abord).
2. Confirmer le domaine final, mettre à jour `redirect/index.html` (`NEW_HOST`), copier `deploy/pages.yml.apres-bascule` sur `.github/workflows/pages.yml`.
3. Fusionner `vps-migration` dans `main` : Coolify redéploie sur le domaine final, GitHub Pages ne publie plus que la redirection (le code `#c=` est conservé).
4. Côté Supabase : `select cron.unschedule('noel-refresh');` puis garder le projet 2 à 4 semaines avant de le mettre en pause.
Retour arrière : annuler la fusion (revert) ; Pages et Supabase reprennent. Les saisies faites sur le VPS entre-temps seraient à recopier.

## F. Après la bascule
Mettre à jour `CLAUDE.md` (sections Publier / Supabase / règles 2 et 5), `supabase/schema.sql` (bloc pg_cron), et choisir le mode de migrations de base (guide, section 14).
