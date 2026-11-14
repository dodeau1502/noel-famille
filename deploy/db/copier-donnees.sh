#!/bin/sh
# Copie les données de Supabase vers la base « noel » par un tuyau direct : aucun fichier intermédiaire, aucune donnée affichée
# (les réservations de noel_claims ne sont lues par personne : règle 1).
# Usage :
#   read -rs SRC   # chaîne Supabase « Session pooler » (Connect dans le tableau de bord)
#   read -rs DST   # chaîne postgres://postgres:...@hote:5432/noel
#   export SRC DST; sh deploy/db/copier-donnees.sh <version-majeure-postgres>
# La base noel doit être vide de données (schéma seulement). noel_attempts (journal temporaire) n'est pas copiée.
set -eu
: "${SRC:?}"; : "${DST:?}"; V="${1:?version majeure de postgres (ex. 17)}"
docker run --rm -i -e SRC -e DST "postgres:$V" sh -c '
  pg_dump "$SRC" --data-only --no-owner --no-privileges \
    -t public.noel_config -t public.noel_gifts -t public.noel_claims \
    -t public.noel_prices -t public.noel_blocked -t public.noel_domains \
  | psql "$DST" -v ON_ERROR_STOP=1 -q --single-transaction
  psql "$DST" -v ON_ERROR_STOP=1 -q -c "select setval(pg_get_serial_sequence(\$\$public.noel_gifts\$\$, \$\$id\$\$), greatest(coalesce((select max(id) from public.noel_gifts),0),1), (select count(*)>0 from public.noel_gifts))" \
                                  -c "select setval(pg_get_serial_sequence(\$\$public.noel_prices\$\$, \$\$id\$\$), greatest(coalesce((select max(id) from public.noel_prices),0),1), (select count(*)>0 from public.noel_prices))" >/dev/null'
echo "Copie terminée. Comparer les comptes (voir RUNBOOK)."
