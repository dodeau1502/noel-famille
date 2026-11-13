#!/bin/sh
# Applique supabase/schema.sql sur la base « noel » du PostgreSQL central, sans pg_cron / pg_net
# (remplacés par la tâche planifiée Coolify), en tant que noel_owner et en une seule transaction.
# Usage : PGURI="postgres://postgres:...@hote:5432/noel" sh deploy/db/appliquer-schema.sh
# (la chaîne de connexion se saisit avec « read -s », jamais dans l'historique ni dans un fichier)
set -eu
: "${PGURI:?variable PGURI manquante}"
DIR=$(cd "$(dirname "$0")" && pwd)
{ echo "set role noel_owner;"; grep -v -E '^create extension if not exists (pg_cron|pg_net);' "$DIR/../../supabase/schema.sql"; } \
  | psql "$PGURI" -v ON_ERROR_STOP=1 --single-transaction -q
psql "$PGURI" -v ON_ERROR_STOP=1 -q -f "$DIR/03-droits.sql"
echo "Schéma appliqué."
