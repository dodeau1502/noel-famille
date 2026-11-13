-- À exécuter en superutilisateur, connecté à la base « postgres » du PostgreSQL central :
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v mdp="$NOEL_DB_PASSWORD" -f 01-roles-et-base.sql
-- Le mot de passe n'est jamais écrit dans ce fichier : il vient de la variable psql « mdp ».
-- Les rôles sont communs à tout le serveur PostgreSQL ; les noms anon / authenticated / service_role sont ceux
-- qu'attend schema.sql. Aucune autre base n'accorde de droits à ces rôles.
create role noel_owner nologin;                       -- propriétaire des objets (pas superutilisateur)
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;           -- utilisé par les fonctions serveur, jamais exposé
create role noel_authenticator login noinherit password :'mdp';
grant anon, service_role to noel_authenticator;

create database noel owner noel_owner;
revoke connect on database noel from public;
grant connect on database noel to noel_authenticator;
