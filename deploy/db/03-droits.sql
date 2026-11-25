-- À exécuter APRÈS schema.sql, en superutilisateur, connecté à la base « noel ».
-- Droits des fonctions serveur (clé service). noel_claims n'y figure volontairement pas (règle 1).
-- anon et authenticated n'ont aucun droit sur les tables (règle 2) : seules les fonctions noel_* leur sont ouvertes par schema.sql.
grant select on public.noel_blocked to service_role;
grant select, insert, update on public.noel_domains to service_role;
grant select, update on public.noel_gifts to service_role;
grant select, insert on public.noel_prices to service_role;
-- Radar des promotions (26 novembre) : flux, pistes, état des sources, compteur SerpAPI.
grant select, insert, update on public.noel_signals to service_role;
grant select, insert, delete on public.noel_feed_seen to service_role;
grant select, insert, update on public.noel_sources to service_role;
grant select, insert, update on public.noel_serp_usage to service_role;
grant select, insert, delete on public.noel_observations to service_role;   -- lot O : un relevé par marchand
grant execute on function public.noel_job_lease(text,int,text), public.noel_radar_purge(), public.noel_serp_bump(text,int) to service_role;
-- Vérification : \dp public.noel_claims ne doit montrer AUCUN droit pour service_role.
