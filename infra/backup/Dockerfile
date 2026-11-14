# Image minimale de sauvegarde (Liste de Noël) : client PostgreSQL 17, age, client S3. Base de l'image épinglée.
FROM alpine:3.22
RUN apk add --no-cache bash postgresql17-client age aws-cli coreutils gawk \
 && adduser -D -u 10001 backup
COPY deploy/backup-noel.sh /usr/local/bin/backup-noel.sh
ENV BACKUP_OUT_DIR=/tmp/backup
USER backup
ENTRYPOINT ["/usr/local/bin/backup-noel.sh"]
