#!/usr/bin/env bash
# Sauvegarde VPS (Liste de Noël, adaptée de la sauvegarde de Finance) : pg_dump (schéma public, données seules) chiffré avec age, puis envoi vers un stockage S3. FAIL-CLOSED.
# Tout est dans la base « noel » (aucun fichier à part). Le dump contient noel_claims (réservations) : il est chiffré avant tout envoi.
# Variables OBLIGATOIRES (aucune valeur de repli) :
#   BACKUP_DATABASE_URL, BACKUP_AGE_RECIPIENT (age1…, clé PUBLIQUE),
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (ex. staging ou production), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
#   BACKUP_RETENTION_DAYS (entier >= 1, fixé par Dorian).
# Facultatives : BACKUP_S3_REGION (défaut us-east-1), BACKUP_LOCAL_ONLY=1 (essais : écrit dans BACKUP_OUT_DIR, n'envoie rien ;
#   dans ce mode les variables BACKUP_S3_* et AWS_* ne sont pas exigées).
# Contrôles : dump complet (marqueur de fin de pg_dump ; une base vide est acceptée, sans ligne témoin), fichier non vide avec en-tête age.
# Rien n'est publié tant que tout n'est pas validé : aucun fichier partiel. Aucun secret n'est affiché.
set -euo pipefail

LOCAL_ONLY="${BACKUP_LOCAL_ONLY:-0}"
need="BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_RETENTION_DAYS"
[ "$LOCAL_ONLY" = 1 ] || need="$need BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_PREFIX AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
missing=""
for v in $need; do [ -n "${!v:-}" ] || missing="$missing $v"; done
[ -z "$missing" ] || { echo "Sauvegarde refusée : variable(s) manquante(s) :$missing" >&2; exit 1; }

case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  *) echo "BACKUP_AGE_RECIPIENT doit être une clé PUBLIQUE age (age1…), jamais la clé privée." >&2; exit 1 ;;
esac
case "$BACKUP_RETENTION_DAYS" in ''|*[!0-9]*|0) echo "BACKUP_RETENTION_DAYS doit être un entier >= 1." >&2; exit 1 ;; esac
case "${BACKUP_S3_PREFIX:-x}" in */*|'') [ "$LOCAL_ONLY" = 1 ] || { echo "BACKUP_S3_PREFIX : un seul segment, sans « / »." >&2; exit 1; } ;; esac
for t in age awk pg_dump; do command -v "$t" >/dev/null || { echo "$t est requis." >&2; exit 1; }; done
[ "$LOCAL_ONLY" = 1 ] || command -v aws >/dev/null || { echo "aws (client S3) est requis." >&2; exit 1; }

OUT="${BACKUP_OUT_DIR:-backup}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="db-$STAMP.sql.age"
mkdir -p "$OUT"
STAGE="$(mktemp -d "$OUT/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

"${PG_DUMP:-pg_dump}" --no-owner --no-privileges --schema=public --data-only --inserts "$BACKUP_DATABASE_URL" \
  | awk '{ print } /^-- PostgreSQL database dump complete/ { done = 1 } END { if (!done) exit 3 }' \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$STAGE/$NAME"

f="$STAGE/$NAME"
[ -s "$f" ] || { echo "Fichier vide ou absent." >&2; exit 1; }
head -c 21 "$f" | grep -q '^age-encryption.org' || { echo "En-tête age absent." >&2; exit 1; }

if [ "$LOCAL_ONLY" = 1 ]; then
  mv "$f" "$OUT/$NAME"
  echo "Sauvegarde écrite : $OUT/$NAME ($(wc -c < "$OUT/$NAME") octets)"
  exit 0
fi

export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" AWS_EC2_METADATA_DISABLED=true
S3=(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3api)
KEY="$BACKUP_S3_PREFIX/$NAME"
"${S3[@]}" put-object --bucket "$BACKUP_S3_BUCKET" --key "$KEY" --body "$f" >/dev/null \
  || { echo "Envoi S3 impossible : aucune sauvegarde publiée." >&2; exit 1; }
# Vérification : l'objet existe avec la bonne taille.
size_local="$(wc -c < "$f" | tr -d ' ')"
size_remote="$("${S3[@]}" head-object --bucket "$BACKUP_S3_BUCKET" --key "$KEY" --query ContentLength --output text)"
[ "$size_local" = "$size_remote" ] || { echo "Taille distante différente (local $size_local, distant $size_remote)." >&2; exit 1; }
echo "Sauvegarde envoyée : $BACKUP_S3_PREFIX/$NAME ($size_local octets)"

# Rétention : supprime les objets db-*.age du préfixe plus anciens que N jours (d'après l'horodatage du nom), sans jamais
# supprimer l'objet qui vient d'être écrit.
cutoff="$(date -u -d "@$(( $(date -u +%s) - BACKUP_RETENTION_DAYS * 86400 ))" +%Y%m%dT%H%M%SZ)"
"${S3[@]}" list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "$BACKUP_S3_PREFIX/db-" --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | while read -r k; do
    [ -n "$k" ] && [ "$k" != None ] || continue
    b="${k##*/db-}"; b="${b%.sql.age}"
    if [[ "$b" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [[ "$b" < "$cutoff" ]] && [ "$k" != "$KEY" ]; then
      "${S3[@]}" delete-object --bucket "$BACKUP_S3_BUCKET" --key "$k" >/dev/null && echo "Ancienne sauvegarde supprimée : $k"
    fi
  done
