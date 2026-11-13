-- À exécuter en superutilisateur, connecté à la base « noel » :
--   psql -U postgres -d noel -v ON_ERROR_STOP=1 -f 02-preparation.sql
create schema if not exists extensions authorization noel_owner;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
