#!/usr/bin/env bash
# Test de restauration (Liste de Noël), à lancer sur le Mac (clé privée age locale, jamais sur le serveur). Prérequis : Docker, age.
#   BACKUP_AGE_IDENTITY=~/age-backup-key.txt ./deploy/restore-test-noel.sh db-AAAAMMJJTHHMMSSZ.sql.age
# Rejoue rôles + base + schéma + droits (deploy/db, supabase/schema.sql) dans un PostgreSQL 17 jetable, puis le dump chiffré,
# et affiche les effectifs. Les réservations (noel_claims) sont COMPTÉES, jamais affichées ni lues.
# Variables facultatives : EXPECT_GIFTS (entier : effectif attendu de noel_gifts, échec si différent), RESTORE_PG_IMAGE (défaut postgres:17).
# Tout échec donne un code ≠ 0. Le conteneur jetable est supprimé à la fin.
set -euo pipefail
DB="${1:?usage: restore-test-noel.sh db-AAAAMMJJTHHMMSSZ.sql.age}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY manquante (chemin du fichier de clé privée age)}"
[ -r "$BACKUP_AGE_IDENTITY" ] || { echo "Clé privée illisible." >&2; exit 1; }
[ -s "$DB" ] || { echo "Archive absente ou vide." >&2; exit 1; }
for t in age docker; do command -v "$t" >/dev/null || { echo "$t est requis." >&2; exit 1; }; done
HERE="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="$HERE/../supabase/schema.sql"
[ -r "$SCHEMA" ] || { echo "supabase/schema.sql introuvable." >&2; exit 1; }

NAME="restore-test-noel-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test "${RESTORE_PG_IMAGE:-postgres:17}" >/dev/null
ready=0
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] || { echo "PostgreSQL jetable non disponible." >&2; exit 1; }
sleep 2
P() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Mot de passe factice : cette base est jetable.
{ printf "\\\\set mdp 'jetable'\n"; cat "$HERE/db/01-roles-et-base.sql"; } | P -d postgres >/dev/null
P -d noel < "$HERE/db/02-preparation.sql" >/dev/null
{ echo "set role noel_owner;"; grep -v -E '^create extension if not exists (pg_cron|pg_net);' "$SCHEMA"; } | P -d noel --single-transaction >/dev/null
P -d noel < "$HERE/db/03-droits.sql" >/dev/null
# Le dump ne contient que des données : rejeu avec contrôles de clés étrangères différés (superuser du conteneur jetable).
age -d -i "$BACKUP_AGE_IDENTITY" "$DB" | docker exec -i -e PGOPTIONS='-c session_replication_role=replica' "$NAME" \
  psql -U postgres -d noel -v ON_ERROR_STOP=1 -q >/dev/null
echo "== Lignes restaurées (à comparer avec le serveur) =="
COUNTS="$(P -d noel -At -F ' : ' -c "
  select 'noel_config', count(*) from noel_config union all
  select 'noel_gifts', count(*) from noel_gifts union all
  select 'noel_claims', count(*) from noel_claims union all
  select 'noel_prices', count(*) from noel_prices union all
  select 'noel_blocked', count(*) from noel_blocked union all
  select 'noel_domains', count(*) from noel_domains union all
  select 'noel_members', count(*) from noel_members union all
  select 'noel_groups', count(*) from noel_groups union all
  select 'noel_shares', count(*) from noel_shares union all
  select 'noel_journal', count(*) from noel_journal;")"
echo "$COUNTS"
# Intégrité référentielle après rejeu (les FK étaient différées) : aucune réservation ni prix orphelin.
ORPH="$(P -d noel -At -c "select (select count(*) from noel_claims c where not exists (select 1 from noel_gifts g where g.id=c.gift_id)) + (select count(*) from noel_prices p where not exists (select 1 from noel_gifts g where g.id=p.gift_id))")"
[ "$ORPH" = 0 ] || { echo "Restauration invalide : $ORPH ligne(s) orpheline(s)." >&2; exit 1; }
if [ -n "${EXPECT_GIFTS:-}" ]; then
  echo "$COUNTS" | grep -qx "noel_gifts : $EXPECT_GIFTS" || { echo "Restauration invalide : noel_gifts devrait contenir $EXPECT_GIFTS ligne(s)." >&2; exit 1; }
fi
echo "Restauration d'essai réussie : note la date dans le journal d'exploitation."
