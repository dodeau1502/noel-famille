-- À exécuter APRÈS schema.sql, en superutilisateur, connecté à la base « noel ».
-- Droits des fonctions serveur (clé service). noel_claims n'y figure volontairement pas (règle 1).
-- anon et authenticated n'ont aucun droit sur les tables (règle 2) : seules les fonctions noel_* leur sont ouvertes par schema.sql.
grant select on public.noel_blocked to service_role;
grant select, insert, update on public.noel_domains to service_role;
grant select, update on public.noel_gifts to service_role;
grant select, insert on public.noel_prices to service_role;
