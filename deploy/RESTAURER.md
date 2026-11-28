# Restaurer une liste

Aucun secret dans ce fichier. Base de production : conteneur `iytbupytjfucaiabhuezrm3g`, base `noel`, accès `ssh ovh`.
**Avant toute réparation : faire une copie de l'état actuel** (cas 4, première commande).

## 1. Un cadeau retiré par erreur
Dans la page : la liste concernée > « Corbeille » > « Remettre dans la liste » (la personne, ou l'administrateur).

## 2. Un compte supprimé par erreur
« Gérer la famille » > « Comptes supprimés » > « Restaurer », puis « Réinitialiser le code » (ou un nouveau lien s'il n'avait jamais été activé).
La liste, les groupes et ce que la personne offrait reviennent (sauf si quelqu'un a pris le cadeau entre-temps).

## 3. Un cadeau modifié par erreur (nom, taille, lien, photo…)
Le journal `noel_journal` garde chaque version d'avant. Dans `psql -U postgres -d noel` :

```sql
-- retrouver les versions (changer le mot cherché)
select id, at, data ->> 'id' as cadeau, data ->> 'title' as nom, data ->> 'size' as taille
  from noel_journal where tbl = 'noel_gifts' and data ->> 'title' ilike '%pull%' order by at desc;
-- remettre la version voulue (remplacer 123 par l'identifiant de la ligne du journal)
update noel_gifts g set title = r.title, url = r.url, size = r.size, color = r.color, note = r.note, variant = r.variant,
       image_url = r.image_url, price = r.price, store = r.store, top = r.top
  from noel_journal j, jsonb_populate_record(null::noel_gifts, j.data) r
 where j.id = 123 and g.id = r.id;
```
Ne pas afficher les lignes `noel_claims` / `noel_shares` du journal à propos de sa propre liste : elles disent qui offre quoi.

## 4. Base abîmée ou perdue
Copie complète de l'état actuel (à faire d'abord, et avant tout changement de la base) :

```bash
ssh ovh 'umask 077; sudo docker exec iytbupytjfucaiabhuezrm3g pg_dump -U postgres -Fc noel > ~/noel-avant-reparation-$(date +%Y%m%d-%H%M).dump'
```

Deux sources :
- **Copies complètes sur le VPS** (`/home/debian/noel-*.dump`, faites avant les mises en production) : `pg_restore` dans une base vide.
- **Sauvegardes automatiques chiffrées** (stockage S3, préfixe `noel/`, 30 jours). Il faut la **clé privée age** de Dorian. Sans elle, elles sont illisibles.
  Vérifier qu'on a la bonne clé (doit afficher `age1ajx6zump3h9c4g2nfmxf895p4ddev4m8p2plvvm7j5hqcf7j2ucqkqk4eh`) :
  `age-keygen -y chemin/de/la/cle.txt`
  Puis essayer l'archive sur le Mac, sans toucher au serveur : `BACKUP_AGE_IDENTITY=chemin/de/la/cle.txt ./deploy/restore-test-noel.sh db-….sql.age`

Toujours restaurer d'abord dans une base d'essai, comparer, puis seulement remplacer. La restauration des données se fait avec
`PGOPTIONS='-c session_replication_role=replica'` (les protections contre la suppression et le journal sont alors inactifs).

**Archives antérieures au correctif `--column-inserts`** : elles ne nomment pas les colonnes et ne se rejouent PAS sur `schema.sql`.
Les rejouer sur la structure tirée d'une copie complète du VPS (`pg_restore --schema-only`).

## Contrôle à refaire après tout changement de la base
Reconstruire une base vide (`deploy/db/02-preparation.sql`, `supabase/schema.sql`, `deploy/db/03-droits.sql`), y rejouer
`pg_dump --data-only --column-inserts` de la production, comparer les effectifs, supprimer la base d'essai.
