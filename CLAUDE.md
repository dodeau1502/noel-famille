# Liste de Noël famille : consignes pour l'IA

## ÉTAT ACTUEL (29 novembre 2026) : comptes, une liste par personne. REMPLACE tout ce qui suit et le contredit
Demande de Dorian : TRÈS simple, pour créer sa liste comme pour choisir sur celles des autres. Les sections plus bas (codes famille / propriétaire,
vue publique, prix vérifiés, comparateurs, radar, balayage) sont HISTORIQUES : leur code est gardé en stock mais plus rien n'est affiché ni lancé.
- Compte = identifiant créé par l'administrateur (Dorian) + code à 4 chiffres choisi à la première ouverture d'un lien d'invitation à usage unique (`#inv=`).
  Session par jeton (`localStorage` `session`). Blocage après 5 codes faux (15 min, puis 1 h, puis 24 h). Chacun peut changer son code (`#code`).
  Code oublié : l'administrateur réinitialise (`noel_admin_reset`), la personne a 48 h pour entrer son identifiant, code vide, et en choisir un nouveau
  (pendant ce délai, quiconque connaît l'identifiant pourrait le faire à sa place). L'administrateur oublie le sien : `#installation` avec l'ancien code propriétaire.
- Plusieurs groupes (gérés par l'administrateur seul) : on voit les listes des personnes qui partagent un groupe. Chacun une seule liste, la sienne.
- Comptes SANS liste et listes visibles (28 novembre, migration `2026-12-03-noel-vues`, en production) : `noel_members.has_list` (faux = la personne
  offre seulement : invisible des autres, liste refusée sauf à l'administrateur ; identifiant + code comme tout le monde) et `sees_all` (faux = ne voit,
  dans ses groupes, que les listes cochées dans `noel_member_sees`). Tout passe par `noel_sees` (liste, prise, participation) et `noel_home`.
  Réglages par l'administrateur seul : « Gérer la famille », pour chaque compte (`noel_admin_views`, `noel_admin_member_view`), et case « Pas de liste »
  à la création. Journalisé. Règle 1 inchangée. Essai : `supabase/tests/vues.sql` (copie jetable seulement).
- L'administrateur voit toutes les listes et peut y ajouter, modifier, retirer (même avant activation du compte), via « Gérer la famille » (migration `2026-11-30`).
  Sur sa propre liste il ne voit rien, comme tout le monde.
- Sur la liste d'un autre : « Je l'offre » ou « Participer à plusieurs » avec un montant (`noel_shares`, exclusif avec la prise seule), « Pris par X »
  (nom visible même d'un autre groupe), « Ce que j'offre » sur le menu, avec une alerte si le cadeau a été modifié (`changed_at`) ou retiré.
- Profil et interface (28 novembre, demande de Dorian ; migration `2026-12-04-noel-profil`, EN PRODUCTION le 28 novembre, pas sur `noel-dev-db`) : chacun change son
  prénom affiché (jamais son identifiant ; un prénom porté par un autre compte actif est refusé) et met une photo de profil (carré 400 px dans
  `noel_photos`, colonne `noel_members.photo`, `noel_profile_save`, `noel_faces` = mon identifiant + photos des personnes que je vois ; servie à
  `/photo/<id>.jpg`, adresse non devinable mais sans connexion). Interface : barre en bas (Listes, Ma liste, Ajouter, J'offre, Profil), cachée pendant
  une saisie ; écran « Ce que j'offre » (`#offre`, total à peu près, par personne) ; réglages et « Gérer la famille » dans `#profil` ; messages de
  confirmation ; sur téléphone, photo du cadeau à gauche (112 px). Essais : `supabase/tests/profil.sql` (copie jetable). Mise en ligne : migration AVANT
  la page (sinon le profil ne s'enregistre pas).
- Photo par recherche d'images (28 novembre) : quand un lien ne donne aucune photo et que `SERPAPI_KEY` est posée, `noel-link` cherche des images
  (SerpAPI `google_images`, `noel-link/photos.js`, test `photos.test.mjs`) : la première est mise, jusqu'à 6 proposées. 15 recherches par membre et par heure.
  Images seulement, aucun prix. NON essayé avec la vraie API.
- Précisions par cadeau seulement : taille, couleur, autre info. Photo lue sur le lien, adresse d'image collée, ou photo envoyée depuis le téléphone
  (AUTORISÉ par Dorian le 2 décembre, voir « Capture d'écran » plus bas). Pas de profil « tailles et goûts », pas d'idée cachée (refusés par Dorian).
- Capture d'écran → cadeau (2 décembre, demande de Dorian, choix de Gemini par Dorian) : bouton « 📷 Choisir une capture d'écran » au premier écran d'ajout.
  La page réduit l'image (1600 px) et l'envoie à `/functions/v1/noel-capture` (`supabase/functions/noel-capture/`, partie pure `gemini.js`) : Gemini
  (`generateContent`, `GEMINI_MODEL`, défaut `gemini-3.6-flash`) lit nom, prix « client ordinaire » (jamais barré ni membre), couleur, taille, détails, magasin,
  adresse visible et cadre de la photo ; si l'adresse n'est pas visible, seconde requête avec l'outil `google_search` ; un lien n'est gardé que s'il vient des
  sources réellement consultées (redirections Google résolues, `pickLink`, comparateurs et réseaux sociaux écartés, `assertPublic`). Photo : celle du site si
  lisible, sinon la page recadre la capture (cadre 0-1000) et l'enregistre. La capture n'est jamais gardée ni journalisée. Formulaire prérempli, rien n'est
  enregistré sans « Enregistrer ». Limites : 20 captures par membre et par heure, `CAPTURE_DAY_MAX` (300) par jour pour le site (en mémoire).
  Secours (28 novembre) : `gemini()` essaie `GEMINI_MODEL` (20 s au plus) puis `GEMINI_FALLBACK_MODEL` (défaut `gemini-3.5-flash-lite`) sur 404, 429, 5xx ou délai
  dépassé ; les échecs sont journalisés (modèle et raison seulement). Recherches Google (lien d'une capture, lien illisible) : modèle de secours D'ABORD, consigne
  « recherche obligatoire » (sans elle il répond de mémoire, donc sans source, donc aucun lien gardé), second essai pour le lien d'une capture. Production : `GEMINI_MODEL=gemini-3.8-flash`, qui ne répondait pas le 28 novembre.
  `GEMINI_API_KEY` (secret, posé par Dorian dans Coolify, projet Google AVEC facturation : en gratuit, Google peut utiliser les captures et la recherche
  Google n'existe pas) ; vide = la page dit « pas encore activée ». Coût estimé : bien moins d'un centime par capture, recherche Google gratuite jusqu'à
  5 000 par mois (tarifs relevés le 2 décembre). NON essayé avec la vraie API Gemini (pas de clé) : tests avec réponses simulées seulement.
- Attente (28 novembre, demande de Dorian) : lecture d'un lien ou d'une capture = liste d'étapes cochées et barre (`STEPS`, `progStart`). Les étapes
  avancent au temps écoulé, pas d'après le serveur (« même si c'est un peu faux », accepté par Dorian).
- Photos envoyées (`noel_photos`, migration `2026-12-02-noel-photos.sql`, APPLIQUÉE en production le 28 novembre, pas sur `noel-dev-db`) : JPEG ≤ 300 Ko dans la base (donc dans les sauvegardes),
  `noel_photo_add(token, base64)` (40 par heure et par membre), jamais effacées (déclencheur), servies par `server/main.ts` à `/photo/<id>.jpg`
  (`noel_photo_get`, clé de service seulement, refusée par le relais public). L'adresse enregistrée est absolue (`https://<site>/photo/…`)
  car `noel_gift_save` exige `https://`. Un changement de domaine casserait ces adresses.
- Habillage de Noël (28 novembre, demande de Dorian : festif mais DISCRET ; une version chargée, bandeau rouge et boules, a été refusée « trop ») :
  vert sapin = action principale, rouge et or en décor, guirlande immobile en haut, flocons discrets, liseré sucre d'orge sur la barre du bas, sapins avec
  cadeaux au pied (en bas de page sur petit écran, sur les côtés dès 1060 px). `--err` reste réservé aux erreurs et suppressions. Remplace la section « Style » (violet).
- Ordre sur la liste d'un autre (28 novembre, demande de Dorian) : dans chaque groupe (« Très envie », puis le reste), les cadeaux pris (`taken`, par soi aussi)
  passent à la fin ; tri dans la page (`listView`). Jamais sur sa propre liste (règle 1).
- Cadeau pris par moi (`.gift.byme`) : cadre vert et bandeau plein « C'est toi qui l'offres » en haut de la carte ; pris par un autre : grisé.
- Règle 1 inchangée : sur SA liste, aucune donnée de réservation ni de participation (ni champ, ni compteur, ni ordre, ni réponse différente). Retirer un cadeau le garde en base (`removed_at`) :
  celui qui l'avait pris voit « a retiré ce cadeau ». Limite assumée : l'administrateur peut entrer dans un compte réinitialisé ou en créer un faux.
- NE JAMAIS PERDRE UNE LISTE (exigence de Dorian, migration `2026-12-01`) : jamais de `delete` sur `noel_gifts` ni `noel_members` (des déclencheurs le refusent) ;
  retirer = `removed_at` (corbeille dans la page), supprimer un compte = `removed_at` (restaurable). `noel_journal` garde l'état d'avant (jamais exposé : règle 1).
  Toute nouvelle table de données de liste doit être journalisée. Sauvegarde : `--column-inserts` obligatoire. Procédures : `deploy/RESTAURER.md`.
  Avant toute migration en production : `pg_dump -Fc` et répétition sur une copie.
  Actions sensibles (supprimer un compte ou un groupe, réinitialiser un code) : 3 validations, la dernière en restant appuyé 5 s (`dangerBox`).
  Retirer un cadeau garde une seule confirmation (corbeille).
- Aucune recherche ni actualisation de prix : prix indicatif saisi ou lu une seule fois sur la page du lien collé (`supabase/functions/noel-link`, sans SerpAPI).
  `server/main.ts` ne lance plus `startJobs` et ne sert plus `noel-preview` ; `noel-refresh` répond « désactivé » (tâche Coolify `price-refresh` à supprimer par Dorian).
- Base : migration `supabase/migrations/2026-11-29-noel-comptes.sql` (à la fin de `schema.sql`). Toutes les fonctions à code sont fermées à l'API publique.
  Première ouverture après migration : `https://<site>/#installation` avec l'ancien code propriétaire (une seule fois).
- Installé sur `noel.dev` le 28 novembre (branche `dev`), essayé sur PostgreSQL 17 avec `supabase/tests/comptes.sql` (copie jetable `noel_essai` seulement).
- EN PRODUCTION depuis le 28 novembre (commit `7372115`, migration appliquée sur `noel-db`, sauvegarde préalable sur le VPS).
- Photos : lues sur la page du lien (dont Amazon via `landingImage`, `pageImage` de `parse.js`) ; la Fnac refuse (403), ne pas contourner. Pas de SerpAPI (refusé).
  Proposé, pas fait : bouton « Coller la photo ».
  Murs anti-robots (Hollister « Client Challenge » vu depuis le VPS, Amazon, Fnac…) : `BLOCKED` de `net.ts` les reconnaît ; `noel-link` renvoie alors un nom deviné
  d'après l'adresse (`noel-link/guess.js`, test `guess.test.mjs`) avec `guessed:true`, sans photo ni prix. On ne contourne jamais le mur (ni faux navigateur, ni navigateur sans tête côté serveur).
  Repli (2 décembre, si `GEMINI_API_KEY`) : page illisible OU sans prix OU sans photo → Gemini + outil `google_search` (`lookupRequest` / `parseLookup` de
  `noel-capture/gemini.js`) complète ce qui manque, signalé par `searched:true` (« vérifie, surtout le prix »). Rien n'est gardé si la recherche n'a consulté
  aucune source ou n'a pas trouvé CE produit ; une image proposée n'est gardée que si notre serveur la télécharge comme image (`isImage`, `assertPublic`).
  Mêmes compteurs que les captures (20 par heure et par membre, `CAPTURE_DAY_MAX` par jour). REFUSÉ (Dorian ne l'a pas validé) : l'outil « URL context »
  de Gemini, qui ferait lire par Google une page qui nous bloque. Photo toujours absente : bouton « 📷 Pas de photo ? Ajoute une capture de la page »
  dans le formulaire (complète seulement les champs vides ; remplace un nom deviné non retouché). Test : `deno test --allow-env --allow-read supabase/functions/noel-link/index.test.ts`.
- Lien lisible lu par Gemini (28 novembre, `noel-link/page.js`, tests `page.test.mjs` et `index.test.ts`) : quand NOTRE serveur a pu lire la page et que
  `GEMINI_API_KEY` est posée, son contenu (données structurées, options cochées, texte, photos) part à Gemini (sans outil, sortie JSON) qui remplit nom,
  prix client ordinaire (gardé seulement s'il est écrit dans la page), couleur, taille, précisions et photo (choisie par numéro). Une unité des limites de
  captures par lien. Page bloquée : recherche de repli comme avant. NON essayé avec la vraie API ni sur de vrais liens avant la mise en ligne.
- Photo automatique (28 novembre, demande de Dorian, qui revient sur son refus de SerpAPI POUR LES IMAGES seulement) : si un lien n'a donné aucune photo et que
  `SERPAPI_KEY` est posée (offre gratuite, ~250 par mois, par Dorian dans Coolify), `noel-link` cherche des images (`google_images`, `noel-link/photos.js`) d'après
  le nom : jusqu'à 6, vérifiées par notre serveur, la première est mise, les autres proposées sous la photo (`picksHtml`). 15 recherches par membre et par heure.
  Aucune autre recherche SerpAPI (ni prix). Pas de promesse de 100 % : rien trouvé = pas de photo. NON essayé avec la vraie API.
- Photo choisie par la personne (28 novembre) : sous la photo de la fiche, toujours visibles, « Galerie », « Coller » (image ou adresse https du
  presse-papiers ; Ctrl+V sur ordinateur) et « Lien » ; plus de bloc replié « Changer la photo ». Essayé à 390 px avec réponses et presse-papiers simulés,
  PAS sur un vrai iPhone / Android.
- Favori « 🎁 Ma liste de Noël » (`#favori`, lien depuis le menu et le formulaire d'ajout) : favori JavaScript qui s'exécute sur la page du magasin DÉJÀ affichée
  à la personne (tous navigateurs, ordinateur et téléphone), lit nom, photo, prix, options (`site/favori.txt` = copie EXACTE de `extension/extract.js`,
  test `supabase/functions/favori.test.mjs` ; puis `sendToList` de `index.html`, qui ajoute un prix lu à l'écran si les données structurées n'en ont pas)
  et ouvre `/#ajout=<JSON>`. La page garde ces données en `sessionStorage` le temps de la connexion, puis ouvre le formulaire prérempli (`fromPage` :
  liens https seulement, prix 0 à 100 000, texte échappé) ; rien n'est enregistré sans « Enregistrer ». Notre serveur ne lit rien : aucun mur contourné.
  Essayé : Hollister dans un vrai navigateur (nom, photo, prix 19,95 € ; le prix « membre » n'est pas pris), réception déconnecté puis connecté, enregistrement simulé.
  NON essayé : installation et usage sur un vrai iPhone / Android (Chrome Android : taper le nom du favori dans la barre d'adresse).
  Sur écran tactile (`PHONE`, `pointer: coarse`), le favori n'est proposé nulle part (trop compliqué à installer) : téléphone = lien collé ou capture d'écran.
  La page `#favori` reste joignable et le dit. Le bouton capture n'apparaît que si `GET /functions/v1/noel-capture` répond `{"on":true}` (clé Gemini posée).
- EN PRODUCTION le 28 novembre (commits `ac6f347`, `4583ece`) : favori, nom deviné, capture d'écran, recherche de repli, photos. Capture et recherche
  COUPÉES tant que `GEMINI_API_KEY` n'est pas posée par Dorian (la page cache alors le bouton capture).
- NON FAIT : essai à l'écran sur un vrai téléphone ; extension de navigateur pas adaptée (elle ne marchera plus) ;
  ancienne page gardée dans `archive/index-v1-prix.html`.
- Si une nouvelle table est ajoutée : RLS, aucune policy, `revoke all` ; nouvelle fonction : `revoke` de `public` puis `grant` explicite si publique.

Site d'une seule page, servi par un petit serveur Deno avec une base PostgreSQL, le tout sur le VPS de Dorian (`https://noel.dorianlab.fr`, Coolify). Supabase n'est plus utilisé en production depuis la bascule (novembre 2026).
Depuis le 17 novembre, la réservation est RÉACTIVÉE en version ultra-simplifiée (1 clic, anonyme, sans prénom) :
- Famille : ouvre le lien `#c=<code_famille>` qui est mémorisé à vie sur son appareil (`localStorage`). Chaque appareil génère un jeton aléatoire unique (`ftok`). Un bouton « Je le prends » réserve le cadeau en 1 clic via `noel_claim(code, id, ftok)` sans demander de prénom. Sur son propre appareil, un bouton « Annuler » (`noel_unclaim`) permet de se rétracter. Pour les autres membres de la famille, le cadeau est marqué « Déjà pris ».
- Public sans code : ouvre `noel.dorianlab.fr` sans `#c=`, la page appelle `noel_public()` (lecture seule stricte : aucun état « Déjà pris » n'est visible ni renvoyé).
- Propriétaire : page cachée `site/gestion.html` (redirige vers `./#gestion`, saisie du code propriétaire), ou lien `#c=<code propriétaire>`. Un flag `is_owner` est gardé dans `localStorage` pour empêcher l'appareil du propriétaire d'enregistrer accidentellement un code famille. La base PostgreSQL ne renvoie JAMAIS les données de réservation au propriétaire (règle 1). Dans « Réglages de la liste », le propriétaire peut définir/renouveler le code famille et copier le message d'invitation prêt à l'envoi.
Public : famille, y compris peu à l'aise avec le numérique, surtout sur téléphone. Langue : français.

## Vue famille simplifiée (28 novembre 2026, remplace les descriptions plus haut et plus bas)
Demande de Dorian : « très très simple ». Famille et public voient UNE liste numérotée (`famCard`) dans son ordre (« Mes préférés » puis « Autres idées ») : photo, nom, précision (taille, couleur), UN prix, UN magasin. Toucher la carte ouvre directement le produit au magasin (nouvel onglet) ; le seul bouton est la réservation. Aucune fiche côté famille.
Aucun état de prix (vérifié, ancien, rupture), aucun comparateur, autre vendeur, historique, piste, baisse ni fiche détaillée. `simplePrice` ignore les ruptures (souvent fausses). C'est une dérogation voulue à « chaque prix affiche sa date et son état », valable pour cette vue seulement.
Réservation avec prénom (remplace « anonyme sans prénom ») : demandé au premier « Je le prends », gardé dans `localStorage` `nom`, envoyé dans `p_name`. La famille voit « Pris par X », « ✓ Pris par toi » (+ Annuler) et le résumé « Tu as pris ». Les anciennes réservations par jeton `ftok` s'affichent « Déjà pris ». La base ne change pas ; le propriétaire ne reçoit toujours rien (règle 1).
Profil = le prénom : si un autre appareil saisit un prénom qui a déjà des réservations, la page demande « C'est toi ? » (`knownName`). Pas de table de profils ni de mot de passe : un prénom sans réservation n'est pas détecté.
Les pistes et l'historique sont désormais dans le panneau de gestion d'un cadeau.

## Accès (depuis le 17 novembre)
- Famille : lien `#c=<code famille>` partagé par le propriétaire. Conservé dans `localStorage` dès la première visite.
- Visiteur public : aucune connexion, appel à `noel_public()` (lecture seule, aucun état de réservation).
- Propriétaire : page cachée `site/gestion.html` (redirige vers `./#gestion`, saisie du code propriétaire), ou lien `#c=<code propriétaire>`. Le code est gardé dans `localStorage` de l'appareil ; « Quitter la gestion » revient à la vue publique. La page est en `noindex`, mais l'adresse n'est pas un secret : seul le code protège la gestion. Flag `is_owner` empêchant de basculer en vue famille par erreur.

## Structure
- `site/index.html` : toute la page (HTML, CSS, JS, sans build). Seul ce dossier est publié.
- `supabase/schema.sql` : état actuel complet de la base. À mettre à jour après chaque migration.
- `supabase/functions/noel-preview/` : fonction serveur appelée quand le propriétaire tape un lien ou un nom de produit (`discover.ts`).
  Étapes : lecture de la page si c'est un lien (`parse.js` : titre, photo, prix, code-barres, stock) ; Google Shopping (SerpAPI, secret
  `SERPAPI_KEY`) pour repérer la fiche produit exacte (`pickProduct` dans `offers.js`) ; fiche produit Google (`google_immersive_product`)
  pour tous les marchands ; lecture directe des pages des 5 offres les moins chères (`net.ts`, `verify.js`) : chaque offre est
  « vérifiée » (prix confirmé par la page du marchand, avec la date) ou « non vérifiée » (prix Google seulement). Coût : 2 recherches
  SerpAPI par fiche ajoutée en général ; 4 au plus (code-barres en secours si Google ne trouve rien, et seconde fiche de secours lue
  seulement si la première donne moins de 3 marchands retenus). Le propriétaire peut choisir une autre fiche proposée (`token`, 1 recherche de plus).
  Chaque fiche Google ne liste que 2 à 5 marchands : c'est la limite de couverture, pas un défaut de filtrage.
- `supabase/functions/noel-refresh/` : relecture GRATUITE des pages des marchands déjà connus (aucune recherche SerpAPI). Appelée par
  la tâche planifiée Coolify (toutes les 10 min, 3 fiches au plus : celles dont `next_check_at` est passé, voir « Fréquence de relecture » ; en-tête `x-cron-secret`) et par le bouton « Actualiser » du propriétaire.
  L'enregistrement des offres (tri, meilleur prix, historique) est dans `noel-refresh/save.ts` (`saveOffers`), partagé avec le radar ; `refreshOne(id)` relit une fiche sur demande interne.
  Elle écrit le prix, l'état de vérification, le stock et l'historique (`noel_prices`).
- `supabase/functions/noel-preview/{parse.js,offers.js,verify.js,net.ts}` sont copiés à l'identique dans `noel-refresh/`
  (`node supabase/functions/shared.test.mjs` le vérifie). Après une modification, recopier puis redéployer les deux fonctions.
  Tests : `parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs`, `trust.test.mjs` (dans `noel-preview/`) et `shared.test.mjs`.
  `trust.js` (sécurité des marchands) n'existe que dans `noel-preview/` ; `noel-refresh` conserve le champ `trust` des offres sans le recalculer.
- `supabase/functions/noel-radar/` + `server/jobs.ts` : radar des promotions (section « Radar des promotions » plus bas).
- `extension/` : extension de navigateur (Manifest V3, Firefox / Chrome / Safari) qui ajoute à la liste le produit de la page affichée (`noel_add`, et `noel-preview` seulement si la case est cochée : 2 recherches SerpAPI).
  Propriétaire seulement ; aucun code ni clé dans le dossier. Listes `MARKET` / `COMPARATOR` de `extension/lib.js` copiées de `offers.js` (à garder identiques). Détails et limites : `extension/README.md`. Test : `node extension/test/lib.test.mjs`. Non publiée (seul `site/` l'est).
- `site/icon-*.png` : icônes d'écran d'accueil. Le manifeste est créé par la page elle-même (il contient le lien de la liste).
- `server/main.ts`, `Dockerfile`, `docker-compose.coolify.yml` : serveur Deno (page + fonctions `noel-*` + relais PostgREST), PostgREST et service `backup`. `deploy/` : scripts de base, `RUNBOOK.md`.
- `redirect/` + `.github/workflows/pages.yml` : GitHub Pages ne publie plus qu'une redirection vers `noel.dorianlab.fr` (le `#c=` est conservé).

## Publier
Le site est déployé par Coolify depuis ce dépôt (projet `noel`, ressource `noel-app`) : fusionner sur la branche suivie, puis « Redeploy » à la main dans Coolify (pas de webhook), puis vérifier `https://noel.dorianlab.fr/healthz`. Un push sur `main` ne publie que la page de redirection sur GitHub Pages.

**Piège récurrent : Coolify suit la branche `vps-migration`, PAS `main`.** Un « Redeploy » après un push sur `main` redéploie l'ancien commit. Avant de redéployer : `git push origin main:vps-migration` (avance rapide), puis « Redeploy » et contrôler que le commit affiché par Coolify est le bon.
Page d'attente (28 novembre) : dossier `maintenance/` (nginx, code 503, « De retour dans moins de 2 minutes »), ressource Coolify SÉPARÉE de `noel-app`
(Docker Compose, branche `vps-migration`, dossier de base `/maintenance`, AUCUN domaine). Le routage vient de ses étiquettes Traefik : `Host(noel.dorianlab.fr)`,
priorité 1, réseau `coolify` ; l'appli (priorité par défaut, plus haute) gagne dès qu'elle tourne et qu'elle est en bonne santé. La page interroge `/healthz` toutes les 5 s et se recharge.
Elle s'affiche aussi si l'appli plante. Ne jamais poser de priorité explicite sur les routeurs de `noel-app`, ni de domaine sur la page d'attente.
Base de production : conteneur PostgreSQL `iytbupytjfucaiabhuezrm3g` (base `noel`, 9 cadeaux au 25 novembre) ; celui de dev est `vaognnqx0rsscghmbhfkvwsu` (`noel.dev.dorianlab.fr`). Accès : `ssh ovh` (utilisateur `debian`, pas dans le groupe docker : `sudo docker …`). `noel_owner` ne peut pas se connecter : appliquer une migration avec `psql -U postgres -d noel -v ON_ERROR_STOP=1 --single-transaction` en commençant par `set role noel_owner;` (les fonctions gardent ainsi le bon propriétaire), après un `pg_dump -Fc`.
Documentation d'exploitation : dossier `vps-infra` de Dorian (`JOURNAL.md`, `ARCHITECTURE.md`).

## Base et fonctions (VPS)
La base est `noel-db` (PostgreSQL 17, ressource Coolify privée, aucun port publié). Changer la base : écrire une migration SQL, l'appliquer par SSH dans le conteneur (`psql`) en tant que `noel_owner`, puis mettre à jour `supabase/schema.sql`. Les fonctions `noel-preview` et `noel-refresh` tournent dans le service `app` (code du dossier `supabase/functions/`). L'ancien projet Supabase `pegojglksepcfvispcrs` n'est plus la production (gardé quelques semaines, puis en pause) : ne plus y déployer. Les anciennes instructions ci-dessous (`apply_migration`, `deploy_edge_function`, `verify_jwt`) sont obsolètes.

Ancienne description (historique) :
Changer une fonction : `deploy_edge_function` (`noel-preview` : `index.ts`, `discover.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ;
`noel-refresh` : `index.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ; `verify_jwt: true` pour les deux), puis garder le dossier du
dépôt identique à ce qui est déployé. Le relevé toutes les 2 h est maintenant une tâche planifiée Coolify (`price-refresh`, service `app`) ; le bloc `pg_cron` de `schema.sql` est conservé pour l'historique et n'est pas appliqué sur le VPS.

Le secret `SERPAPI_KEY` est une variable de la ressource Coolify (vide pour l'instant : la recherche de produit est désactivée ; jamais dans le dépôt). Règle : on reste sur l'offre gratuite (environ 250 recherches
par mois). Seul l'ajout d'une fiche, le choix d'une autre fiche proposée et le bouton « Autres marchands » (avec confirmation) consomment
des recherches. L'actualisation des prix (automatique ou bouton) lit les pages des marchands directement et ne consomme rien.
Règle décidée par Dorian le 25 novembre : *un seul balayage automatique hebdomadaire, plafonné à 120 recherches par mois (compteur `noel_serp_usage`), le reste du quota gratuit de 250 étant réservé aux actions manuelles ; sans `SERPAPI_KEY`, rien ne s'exécute.* Ce balayage (lot I) est écrit (section « Balayage Google ») ; il n'y a aucun autre appel SerpAPI automatique, et il ne faut pas en ajouter.

## Base : conventions
- Les fonctions `noel_*` renvoient du jsonb `{"ok":true}` ou `{"error":"denied|throttled|taken|short|same_as_owner|empty|invalid"}`,
  elles ne lèvent pas d'exception (sinon l'enregistrement des essais de code ratés serait annulé). La page traduit ces erreurs (`MSG`, `rpc()`).
- Limitation : 15 essais ratés par 10 minutes et par adresse (`noel_attempts`, `noel_role`).
- Fonctions propriétaire : `noel_add`, `noel_remove`, `noel_set_top`, `noel_set_offers`, `noel_set_family_code`, `noel_update_gift`, `noel_edit_offers`, `noel_set_pinned`, `noel_set_display`, `noel_block_merchant`, `noel_unblock_merchant`.
  Fonctions famille : `noel_claim`, `noel_unclaim`, `noel_set_bought`, `noel_set_paid`.
- Tables : `noel_gifts` (dont `gtin`, `checked_at`), `noel_claims` (dont `paid`), `noel_prices` (historique : un point par jour ou à chaque
  changement du meilleur prix, 60 derniers points renvoyés par `noel_get`, identiques pour le propriétaire et la famille).
- Fonctionnalités : « Envie forte », état « Acheté », tri, « Actualiser » (gratuit) et « Autres marchands » (2 recherches SerpAPI, avec
  confirmation), état « vérifié / non vérifié » avec date pour chaque prix, rupture de stock classée en dernier, historique et bandeau
  « Prix en baisse » (sans notification ; une baisse n'est annoncée que si les deux prix ont été lus sur le site du marchand), prix payé et
  « Prix moins cher trouvé » (famille, sur le cadeau qu'elle a pris), choix d'une autre fiche produit, alerte de doublon,
  invitation de la famille (le code famille est gardé dans le navigateur du propriétaire seulement), texte agrandi.
  « Comparer les prix » : liens de recherche ouverts par la famille (Google Shopping, idealo, Le Dénicheur, Dealabs, Amazon) ; idealo et
  Le Dénicheur reçoivent le code-barres (`gtin`) quand il est connu, sinon le nom. Ce sont de simples liens : aucune lecture automatique de
  ces sites, aucun de leurs prix n'est stocké dans `offers` (règle 4 : les comparateurs ne sont pas des marchands).
  Le code d'accès est mémorisé dans `localStorage` de l'appareil (bouton « Quitter »). Pas de service worker.
  Pas prévu volontairement : participation groupée, notification de réservation, commentaires.

## Modifier une fiche, liste de prix déroulante, sites en avant
- « Modifier » (propriétaire) : nom, lien, photo https, précision, code-barres (`noel_update_gift`) et offres par marchand (`noel_edit_offers`, 12 au plus :
  prix, livraison, lien https, rupture, ajout, retrait). Une offre ajoutée ou changée à la main porte `via:"manual"`, `verified:false` et la date : la page
  affiche « Prix saisi à la main, non vérifié » jusqu'à ce que la relecture (`noel-refresh`) confirme le prix sur la page du marchand. Le prix et le marchand de
  la fiche sont recalculés (hors rupture, hors « Prudence » si possible) et un point d'historique est ajouté. La page ne se met pas à jour toute seule pendant
  une modification (`tick`). Les offres manuelles passent les mêmes filtres que la recherche (`isMarket` côté page, règle 4) : pas de place de marché,
  de comparateur ni de marchand écarté. Les offres que la page masque déjà (place de marché, lien non https) ne sont pas conservées à l'enregistrement.
- Liste de prix : 3 offres visibles, les autres dans « Voir les N autres prix » (état ouvert gardé dans `openPrices`).
- Sites en avant : liste commune `noel_config.featured` et ordre par défaut `order_mode` (`noel_set_display`), plus `noel_gifts.pinned` par fiche (`noel_set_pinned`,
  3 au plus). Ils ne changent que l'ORDRE (option « Choix de Dorian d'abord », choisie par chaque appareil dans `localStorage` `om`, sinon l'ordre par défaut) et
  portent la mention « Choix de Dorian ». « Le moins cher » reste calculé sur le prix. Un nom favori correspond à un marchand de même nom ou dont le nom
  commence pareil (« Fnac » et « Fnac.com »). Ces données sont les mêmes pour tous : aucun lien avec les réservations (règle 1).

## Version souhaitée, catégories, budget, fiches comparateurs
- `noel_set_extras` (propriétaire, via « Modifier ») : `variant` (« Version souhaitée », 120 caractères), `category` (libre, 30 caractères), `cmp` (`idealo`, `denicheur` :
  liens https saisis à la main, hôtes validés côté base et côté page : `idealo.*` et `ledenicheur.fr`). Aucun lien avec les réservations (règle 1).
- La catégorie se règle dans « Modifier » (pas dans le formulaire d'ajout). Filtres « Catégorie » et « Budget » de la barre de liste : choix gardé par appareil dans
  `localStorage` (`cat`, `bud`). Le budget compare au meilleur prix en stock (livraison comprise si connue) ; un cadeau sans prix reste affiché.
- « Comparer les prix » : si une fiche idealo / Dénicheur est saisie, le lien pointe vers elle (« fiche du produit ») ; sinon recherche (idealo) ou accueil (Le Dénicheur).
  Ce sont de simples liens : aucune lecture automatique ni prix stocké.

## Classement (refait le 25 novembre)
- Données inchangées : `noel_gifts.top` (préféré) et `noel_gifts.rank` ; `noel_set_top`, `noel_set_rank(code, ids[])`. Aucune migration.
- Ordre affiché (`ordered()`) : « Mes préférés » (`top`), puis « Autres idées » ; dans chaque section par `rank` (sans rang : à la fin). Plus de section « Mon classement » ni de numéros.
- Gestion : glisser la poignée (souris et doigt, `startDrag` : la ligne tenue ne sort jamais de la page, sinon le geste tactile est coupé), flèches ↑ ↓, étoile, « Annuler ».
  Franchir « Autres idées » change `top`. Enregistrement automatique en file (`saveOrder`) ; la mise à jour de 20 s est suspendue pendant un geste ou un enregistrement.
  Une recherche en cours désactive le classement. Identique pour tous, aucun lien avec les réservations (règle 1).

## Règles à ne jamais enfreindre
1. Confidentialité : le propriétaire ne reçoit jamais `claimed_by`, `bought`, `paid` ni aucune donnée de réservation. Ne pas ajouter de colonne,
   de fonction ou d'affichage qui permette de le déduire (ni compteur de cadeaux pris, ni ordre qui change). Le relevé automatique
   (`noel-refresh`) traite toutes les fiches de la même façon : il choisit uniquement d'après `checked_at` et ne lit jamais `noel_claims`
   (sinon les dates de relevé révéleraient quels cadeaux sont pris). L'historique des prix est identique pour tous.
2. (Depuis le 14 novembre, la famille n'a plus de code : `noel_public()`, sans paramètre, est ouverte à `anon` et ne renvoie JAMAIS `claimed_by`, `bought`, `paid` ni `blocked`. Toute autre fonction `noel_*` exige un code.)
   Aucun accès direct aux tables depuis l'API publique : garder RLS activé, aucune policy, `revoke all` pour `anon` et
   `authenticated` (sur le VPS, le serveur Deno ne relaie en plus que les appels `rpc/noel_*` : `/rest/v1/<table>` donne 403). Tout passe par les fonctions `noel_*` qui vérifient un code.
3. Ne jamais écrire le code propriétaire (ni un ancien code famille) dans le dépôt, un commit, une issue ou un message de PR.
   Ils ne sont stockés que sous forme d'empreinte en base. La clé « anon » de Supabase dans `index.html` est publique par conception.
4. Les offres affichées doivent correspondre au produit et être fiables (`offers.js`, doublé côté page par `isMarket`) :
   tous les mots-clés et toutes les références chiffrées de la requête présents (un chiffre seul compte), même version
   (pro, max, combo, pack…), neuf uniquement (occasion, reconditionné, `second_hand_condition` écartés), places de marché et
   identifiants de vendeur écartés (Leboncoin, eBay, Vinted, Back Market, Rakuten…), prix suspects écartés (hors 0,6 à 1,8 fois la
   médiane dès 3 prix), comparateurs écartés (idealo, Kelkoo, Dealabs… : ce ne sont pas des marchands), classement par prix +
   livraison quand elle est connue, rupture de stock en dernier. Exception encadrée : la référence d'une pièce incluse dans un lot
   (« Fly More Combo RC-N3 ») est facultative, mais seulement si elle suit un mot de lot (`optionalTokens`), avec ou sans trait d'union
   (un nom tiré d'une adresse donne « rc n3 ») ; une référence de modèle (WH-1000XM5, X-T5, Xbox 360, Sony A7) reste obligatoire. Les mots « batterie, chargeur, câble… » ne font pas un accessoire quand ils décrivent le
   contenu d'un lot (« avec chargeur », « deux batteries »). Les fiches de secours (`backups`) n'ont pas plus de mots en trop que la
   fiche choisie et sont dans la même fourchette de prix (0,5 à 2 fois). Ne pas assouplir ces règles sans ajouter un test dans `offers.test.mjs` ;
   pour un nouveau site à exclure, l'ajouter aux listes `MARKET` / `COMPARATOR` de `offers.js` (et de sa copie dans `noel-refresh`) et de `index.html`.
   Ne jamais promettre « le meilleur prix absolu » : chaque prix affiche sa source, sa date et son état de vérification. Pas de lien affilié.
5. Les fonctions `noel-preview` et `noel-refresh` ne répondent qu'au code propriétaire (`noel-refresh` accepte aussi le mode planning,
   qui ne renvoie rien de sensible) et refusent les adresses internes à chaque redirection (protection SSRF, `net.ts`).
6. Échapper tout texte venant de la base avant de l'insérer dans le HTML (`esc()`), n'accepter que des liens `http(s)`
   et des images `https`.

## Sécurité des marchands
But : ne pas proposer de site d'arnaque ou douteux. Ce n'est jamais une garantie (un escroc peut avoir un vieux domaine ou de faux avis).
Étape 6 de `discover.ts`, logique dans `trust.js` (testée par `trust.test.mjs`). Niveaux affichés avec chaque offre :
- « known » : marchand de la liste `KNOWN` de `trust.js` (tenue à la main). Reconnu par le domaine quand l'adresse est celle du marchand,
  par le nom seulement quand l'adresse est un lien Google. Limite : « Amazon.fr » désigne le site, pas chaque vendeur tiers.
- « unknown » : aucun signal. « caution » (« Prudence », raisons affichées) : note Google < 3,5 avec au moins 20 avis, site créé il y a moins de
  6 mois (RDAP, cache `noel_domains`, 30 jours), prix au moins 25 % sous la médiane des autres offres (2 autres offres au moins).
- « out » (écarté, non proposé, signalé à l'ajout) : note Google < 3 avec au moins 50 avis, site créé il y a moins de 3 mois.
  Un âge ou une note inconnus n'écartent jamais.
- Liste noire du propriétaire : `noel_blocked` (clé de nom normalisée `noel_key` + domaine), fonctions `noel_block_merchant` /
  `noel_unblock_merchant` (propriétaire seulement, retirent le marchand de toutes les fiches de la même façon, sans lien avec les réservations).
  `noel_get` renvoie `blocked` au propriétaire seulement. Tables sans policy, comme les autres.
- Page : les offres « Prudence » restent visibles avec leurs raisons mais ne sont jamais choisies comme « Le moins cher » (`inStock`).
- Limites : Google ne donne la note d'un marchand que si la fiche la contient (journal `noel-diag`, champ `rated`) ; RDAP peut être absent ;
  `noel-refresh` peut encore compter une offre « Prudence » dans `bestOffer` et l'historique. Les mentions légales du site ne sont volontairement pas lues.

## Style
Direction « Catalogue » (refaite le 25 novembre, `site/index.html` seulement). Polices : Bebas Neue (noms, prix, titres) et Figtree (texte). Violet : action principale ; rouge : suppression et erreurs.
Thème SOMBRE PAR DÉFAUT, « Affichage » : sombre, clair ou automatique, et texte agrandi. Gros boutons, mobile en priorité.
- Famille et public (`famCard`) : une colonne sur téléphone, grille sur ordinateur (déroge à « une seule colonne », choix validé sur maquettes). Photo pleine largeur, nom, précision, prix,
  marchand, état et date du prix, « Je le prends » (famille) et « Voir le cadeau ». Aucun filtre ni tri.
- Fiche (`giftView`, dans `#sheet`) : photo, prix et « Acheter chez X », réservation, autres prix, historique, idealo et Le Dénicheur, autres sites repliés. Deux colonnes dès 760 px.
- Propriétaire (`ownerHtml`, `panelHtml`) : ajout en haut, recherche, « Actualiser tous les prix », liste compacte à classer. Actions du cadeau choisi : colonne de droite dès 960 px, fenêtre sur téléphone
  (Voir comme la famille, Modifier, Actualiser, Gérer les marchands, Retirer). « Voir comme la famille » n'affiche aucun bouton de réservation.
- Retirés le 25 novembre : tri, filtres Catégorie / Budget et choix local de l'ordre des marchands (l'ordre par défaut des « Réglages » s'applique). Le champ catégorie reste dans « Modifier ».
  Les sections plus haut qui les décrivent sont historiques.
- L'état ouvert / fermé des blocs repliés est gardé dans `openK` (attribut `data-k`, fonction `dk()`).
- Les icônes d'écran d'accueil (`icon-*.png`) sont restées vertes.

## Limites connues (à ne pas cacher à l'utilisateur)
- Amazon, Fnac, Darty, Sony, LEGO, Boulanger, Decathlon (défi Cloudflare) et Uniqlo (prix chargé en JavaScript) ne se laissent pas lire : leurs offres restent « non vérifiées » (dernier prix connu, affiché avec sa date, y compris dans la liste de gestion). Seul le balayage Google (SerpAPI) peut les remettre à jour.
- Lecture des pages (`net.ts`) : en-tête `User-Agent` honnête (`NoelFamille/1.0`). Ne pas revenir à un faux « Chrome » : Cloudflare / Shopify répondaient 429 à toutes les lectures (cause des « Ancien prix » du 25 novembre).
- Pages à déclinaisons (tailles, couleurs) : `extract` renvoie `variants` et choisit la déclinaison du lien `?variant=ID` (Shopify) ; `applyPage` confirme le prix connu s'il correspond à l'une des déclinaisons (limite : si la déclinaison voulue change de prix et qu'une autre a l'ancien prix, l'ancien prix est confirmé à tort).
- Cas réel corrigé (DJI Lito X1 Fly More Combo RC-N3) : un seul résultat sur un site inconnu, car la référence RC-N3 était exigée dans
  les titres Google. Les fiches Google restent bruitées (accessoires, autres versions) et ne donnent que 2 à 5 marchands ; avec peu de
  marchands, c'est la couverture de Google qui limite, pas le filtre. Une fiche peut contenir une offre reconditionnée non signalée
  (ex. un prix Fnac anormalement bas) : le prix reste « non vérifié » tant que la page ne le confirme pas.
- Une recherche par nom seul (sans lien) peut choisir la mauvaise fiche : la page propose alors les autres fiches. Le lien du marchand marche mieux.
- Pas de seconde source de prix (Kelkoo/idealo via Apify) ni de copie locale de la photo du marchand ; pas de test quotidien automatique.
- Les formats d'URL de recherche d'idealo et du Dénicheur n'ont pas pu être testés depuis l'environnement de développement (idealo refusé,
  robots.txt du Dénicheur interdit la lecture automatique de ses recherches) : à contrôler à la main sur téléphone, avec et sans code-barres.
  Le 31 octobre, `ledenicheur.fr/search?search=…` renvoie une erreur 404 : le lien Le Dénicheur pointe donc vers l'accueil, jusqu'à ce que le propriétaire donne la bonne adresse de recherche.
- Journal de diagnostic : `noel-preview` écrit une ligne `noel-diag` par recherche (marchands renvoyés par Google, prix, raison de
  conservation ou d'écart : « titre différent », « comparateur », « place de marché… », « occasion »). Ni clé ni code. À lire dans les
  journaux de la fonction ; à retirer une fois le filtrage réglé.
- Lecture automatique d'idealo, de Kelkoo et de Le Dénicheur : NON, même avec l'accord du propriétaire (31 octobre). idealo et Kelkoo
  refusent l'accès automatisé (accès bloqué ou `robots.txt` restrictif), et le `robots.txt` du Dénicheur interdit `/search?`. Ne pas
  contourner (ni Apify, ni mirroir, ni cache). Ces sites restent de simples liens « Comparer les prix ». Le jeton Apify transmis dans
  la conversation n'a pas été enregistré ni utilisé ; il ne doit jamais entrer dans le dépôt.

## Radar des promotions (26 novembre 2026)
But : ne rater aucune promotion publique sur les cadeaux de la liste, sans coût. Guide complet : `GUIDE-RADAR-PRIX.md` de Dorian (lots A à Q ; hors dépôt, qui est public). Fait à ce jour : A, B, C, D, E, F, G, K-minimal, le niveau MPN du lot N, Q (expiration des prix) et O (relevé par marchand) P (fréquence adaptée) et K-complet, L (test quotidien) et I (balayage Google). PAS fait : H (Keepa), J (e-mail).
- `noel-radar/dealabs.js` (lecture du flux RSS : `parseFeed`, `extractFacts`, `cleanLink`), `match.js` (niveaux `exact` / `strict` / `loose`, exclusions), `conditions.js` (code promo, coupon, ODR, membres, nouveaux clients, public restreint, magasin, cagnotte), `index.ts` (collecteur `runDealabs`), `db.ts`.
  Modules purs : tests `node`. Collecteur : `deno test --allow-env --allow-read supabase/functions/noel-radar/index.test.ts` (fetch et base simulés).
- `server/jobs.ts` : planificateur interne (`JOBS_ENABLED=1`, production seulement), verrou `noel_job_lease`. `dealabs:tous` 2 min (1 min pendant 30 min après un trou), `dealabs:hot` 10 min, purge quotidienne 4 h 30. Keepa et e-mail : tâches prévues, désactivées sans variable (stubs).
- Tables (aucune policy, `revoke all` pour `anon` et `authenticated`, droits de `service_role` dans `deploy/db/03-droits.sql`, JAMAIS de droit sur `noel_claims`) : `noel_signals` (pistes), `noel_feed_seen`, `noel_sources` (état et verrous), `noel_serp_usage`. Colonnes de `noel_gifts` : `aliases`, `asin`, `mpn`, `next_check_at` (lot P).
- Fonctions : `noel_signal_decide`, `noel_set_aliases`, `noel_set_asin`, `noel_set_mpn`, `noel_status` (propriétaire) ; `noel_job_lease`, `noel_radar_purge` (service seulement : le relais public de `server/main.ts` les refuse). `noel_get` et `noel_public` renvoient `signals` (5 au plus, acceptées, publiées il y a moins de 72 h ou vérifiées il y a moins de 24 h), `aliases`, `asin` et `mpn`, avec EXACTEMENT les mêmes champs pour tous les rôles.
- Règles : seul le flux RSS officiel de Dealabs est lu (décision du 25 novembre), avec un en-tête honnête, jamais de page de deal, de `/search`, `/graphql`, `/rest-api/`, `/visit/`, jamais de contournement après un 429, 403 ou 5xx. Dealabs reste un comparateur (règle 4) : une piste n'est fusionnée dans `offers` (`via:"dealabs"`) que confirmée sur la page du marchand ET sans condition (code, coupon, ODR, membre…) ; Amazon, Fnac, Darty, Sony, LEGO, Boulanger ne sont pas lus (piste « non vérifiée »). Aucun lien affilié (`cleanLink`). Le radar lit `noel_gifts` sans jointure avec les réservations et traite toutes les fiches de la même façon (règle 1).
- Les agents de code n'ouvrent JAMAIS dealabs.com, même le flux (`robots.txt` : robots d'IA exclus). Tout se teste sur `noel-radar/fixtures/dealabs-tous-2026-11-25.xml`, un flux SYNTHÉTIQUE (structure du vrai flux, textes inventés) : le fichier réduit du vrai flux, cité par le guide, n'était pas dans le dépôt.
- Limites : une promotion hors Dealabs et sur un site illisible peut échapper au radar ; le flux ne garde que ~30 éléments (un trou est compté dans `noel_sources.gaps`, pas rattrapé) ; le compteur de 1 200 requêtes par jour est en mémoire (remis à zéro au redémarrage) ; `noel_edit_offers` remplace un `via` inconnu (dont `dealabs`) par une chaîne vide quand le propriétaire modifie les offres.

## Fraîcheur des prix (lot Q, 25 novembre 2026)
- `freshness(offer, now, fallbackAt)` dans `verify.js` (copié vers `noel-refresh`) : vérifiée 24 h `fresh`, 72 h `aging` ; non vérifiée 48 h `unverified` ; au-delà `stale` (« Ancien prix »). Sans aucune date : jamais `stale`. `bestOffer` ignore les `stale` ; `rank` les met avant les ruptures.
- Page (`freshness`, `cleanOffers` → `_f`) : même tableau avec l'heure du navigateur (`freshness-parity.test.mjs` vérifie la parité). Si toutes les offres en stock sont périmées, la carte garde le dernier prix, barré, avec « Ancien prix, à confirmer ». Données identiques pour tous les rôles (règle 1).
- Limite : `offers_at` est remis à jour à chaque enregistrement, donc une offre Google sans `at` ne vieillit pas par ce repli.

## Relevé par marchand (lot O, 27 novembre 2026)
- Table `noel_observations` (migration `2026-11-27-noel-observations.sql`, droits `select, insert, delete` de `service_role`, aucune policy ; jamais liée aux réservations). `noel_radar_purge` supprime au-delà de 180 jours. `noel_get` / `noel_public` renvoient `low30` (plus bas total VÉRIFIÉ par marchand sur 30 jours), identique pour tous.
- `noel-radar/observe.js` (pur, `observe.test.mjs`) : `shouldRecord` (premier relevé, changement de total / stock / état vérifié, ou plus de 20 h), `low30`, `riseBeforeDrop`, `anomaly`. Écriture dans `saveOffers` (`noel-refresh/save.ts`, donc relecture ET radar ; test `save.test.ts`) : un échec du relevé ne bloque jamais l'enregistrement des offres.
- Dans les offres : `rise` (date du plus bas d'avant la hausse) et `anom` (total < 0,5 × médiane des autres marchands, ≥ 3 relevés ; la page le traite comme « Prudence », jamais « Le moins cher »). Limite : `bestOffer` côté serveur ignore `anom`, comme « Prudence ».
- `noel-preview` n'écrit pas de relevé (il ne touche pas la base) : le premier relevé vient de la première relecture. Migration NON appliquée : dev d'abord, après `pg_dump -Fc`.
- Tests : `node supabase/functions/noel-radar/observe.test.mjs`, `deno test --allow-env --allow-read supabase/functions/noel-refresh/save.test.ts`.

## Boutiques Shopify et prix des sites illisibles (26 novembre 2026)
- Les boutiques Shopify (Greige, Mello, Sea to Summit) répondent 429 à la lecture de leurs pages. `readMerchant` (`net.ts`) passe d'abord par leur interface officielle `/api/ucp/mcp` (`shopify.js`, copié vers `noel-refresh`, test `shopify.test.mjs`) pour tout lien `/products/…` : variante exacte si le lien a `?variant=`, sinon recherche sur le nom de la fiche (la réponse ne contient qu'une partie des déclinaisons). Catalogue seulement, jamais de panier ni de commande. LIMITE : le catalogue ignore les remises affichées par le site (Mello, Black Friday : 207,92 € sur la page, 259,90 € au catalogue) ; un prix de catalogue plus haut que le prix connu ne le remplace donc pas (`info.catalog`, `verify.js`), et une vraie hausse n'est pas reprise. Un prix « vérifié » par le catalogue peut être plus haut que le prix payé. 429 / 403 : respecté, aucun repli. Autre échec : lecture de la page comme avant.
- La boutique lit notre profil `site/ucp-agent.json` (publié par le serveur) : il doit être en ligne en production pour que la lecture marche. Variable `UCP_PROFILE` pour les essais (profil d'exemple de Shopify). Aucune signature Web Bot Auth : Shopify la demande aux serveurs, des limites plus strictes restent possibles.
- Sites illisibles (Amazon, Uniqlo, Decathlon…) : bouton « Mettre à jour le prix » de l'extension (`noel_edit_offers`, `via:"page"`, non vérifié, périmé après 48 h). Pas d'automatique.

## Fréquence de relecture (lot P, 27 novembre 2026)
- `noel-refresh/schedule.js` (pur, `schedule.test.mjs`) : `nextCheck` ne lit QUE `lastSignalAt`, `lastChangeAt`, `readableCount`, `inHighPeriod` (un test avec Proxy refuse toute autre clé, dont `claimed`, `bought`, `paid`). Échéances : 15 min (piste acceptée < 6 h), 30 min (total vérifié changé < 48 h), 45 min (période forte, `HIGH_PERIODS`), 60 min, 6 h sans offre lisible, ±10 %.
- `noel-refresh` choisit les fiches par `next_check_at` (nulles d'abord) dans `noel_gifts` seulement. Plafonds : `REFRESH_MAX_READS_H` (120 par heure, `noel_sources` « refresh »), 20 s et 60 par heure par domaine (en mémoire). Sites illisibles (Amazon, Fnac, Darty, Sony, LEGO, Boulanger, Decathlon, Uniqlo) jamais relus ; `offers[].fails` / `tried_at` : après 3 échecs, une lecture par 24 h. Le bouton « Actualiser » du propriétaire ignore ces plafonds (sauf pour les fiches elles-mêmes).
- Le radar pose `next_check_at = now` pour une fiche qui reçoit une piste acceptée ; le prochain passage la relit. `REFRESH_MIN_AGE_MIN` n'est plus utilisée. Tâche Coolify `price-refresh` à passer en `*/10 * * * *` (par Dorian).
- Limites : le plafond par domaine est en mémoire (remis à zéro au redémarrage) ; `refreshOne` est conservé mais plus appelé.

## Interface du radar (K-complet, 27 novembre 2026)
- Gestion (propriétaire seulement) : `load()` appelle `noel_status` ; carte « État des sources » (`#srcCard`, `renderSources`) avec dernière lecture, trous Dealabs, compteur Google, nombre de pistes à confirmer. Bandeau rouge (`sourceAlerts`) : `dealabs:tous` sans lecture réussie depuis 15 min entre 8 h et 1 h (heure du navigateur), autre source au-delà de 3 fois son intervalle, ou échec du `selftest` (lot L). Une source qui n'a jamais tourné ne déclenche rien.
- Panneau d'un cadeau, section « Surveillance » (`watchHtml`) : surnoms, ASIN, référence constructeur (`noel_set_aliases`, `noel_set_asin`, `noel_set_mpn`, un seul bouton Enregistrer, brouillon `wdraft` gardé pendant les rafraîchissements), lien « Suivre sur Keepa » (`keepa.com/#!product/4-<ASIN>`, le domaine 4 = amazon.fr reste à confirmer par Dorian), pistes « À confirmer » avec « C'est ce cadeau » / « Non » (`noel_signal_decide`).
- Test : `node supabase/functions/source-alerts.test.mjs`. Rendu vérifié à 375 px (sans défilement horizontal) et en bureau avec des réponses simulées.

## Test quotidien (lot L, 27 novembre 2026)
- `noel-radar/selftest.ts` (+ `selftest.js` pur), tâche `selftest` de `server/jobs.ts` à 7 h 15 (Paris, verrou 300 s). Trois contrôles : (1) `parseFeed` / `matchAll` / `conditionsOf` sur le fichier de test donnent le résumé attendu (régression du code) ; (2) la dernière lecture complète réelle de `dealabs:tous` (en mémoire, `feedStats`) avait au moins 5 éléments avec titre et lien et au moins 1 `pepper:merchant` (changement de format ; pas de lecture depuis le démarrage : non évalué, jamais un échec) ; (3) au moins 1 page sur les 2 premiers cadeaux (par id) ayant une offre sur un marchand lisible donne un prix (une seule page en panne est du bruit).
- Résultat dans `noel_sources` (`selftest` : `last_ok`, ou `last_error` + `last_error_at`) : un échec allume le bandeau rouge de la gestion. Aucun e-mail ni notification. Lit seulement `noel_gifts`, sans lien avec les réservations.
- Le `Dockerfile` autorise la lecture de `supabase/functions/noel-radar/fixtures` (`--allow-read=site,supabase/functions/noel-radar/fixtures`) pour le fichier de test. Tests : `deno test --allow-env --allow-read supabase/functions/noel-radar/selftest.test.ts`.

## Balayage Google hebdomadaire (lot I, 28 novembre 2026)
- `noel-radar/sweep.ts` (`runSweep`), tâche `google` de `server/jobs.ts` : lundi 4 h 10 (Paris), verrou 3 600 s, délai maximal 30 min, active seulement avec `SERPAPI_KEY`. Parcourt TOUS les cadeaux par id croissant (aucune priorité, règle 1), relance `discover` (même circuit que « Autres marchands » : filtres, vérification des pages, `trust.js`, liste noire) et fusionne prudemment (`mergeFound` : marchands nouveaux ajoutés ; un marchand connu n'est remplacé que par une lecture vérifiée plus fraîche, jamais une saisie manuelle) puis `saveOffers`. Curseur = `noel_sources` « google », `items_last` (dernier cadeau terminé ; 0 en fin de cycle).
- Plafond : `SERP_AUTO_CAP` (défaut 120) recherches automatiques par mois. Chaque recherche SerpAPI passe par `noel_serp_bump` (migration `2026-11-28-noel-serp-bump.sql`, atomique, `service_role` seulement, refusée par le relais public de `server/main.ts`) qui incrémente AVANT l'appel ; au plafond, le balayage s'arrête net et reprend au cadeau suivant la semaine d'après. Les actions manuelles (`discover` sans `use`) sont comptées (`manual`) mais jamais bloquées, même si le compteur est en panne ; le balayage, lui, ne part pas sans compteur.
- Les tâches à heure fixe (`fixed` : purge, selftest, google) ont un décalage de 0 à 5 min, pas ±10 % (sinon le lundi dériverait de ±17 h).
- Migration NON appliquée : dev d'abord, après `pg_dump -Fc`. Tests : `deno test --allow-env --allow-read supabase/functions/noel-radar/sweep.test.ts`.

## Vérifier avant de pousser
- `node supabase/functions/favori.test.mjs`, `node supabase/functions/noel-link/guess.test.mjs`, `node supabase/functions/noel-capture/gemini.test.mjs`,
  `deno test --allow-env --allow-read supabase/functions/noel-capture/index.test.ts`
- `node supabase/functions/noel-preview/parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs`, `trust.test.mjs` et `node supabase/functions/shared.test.mjs`, `node supabase/functions/freshness-parity.test.mjs`
- Radar : `node supabase/functions/noel-radar/dealabs.test.mjs`, `conditions.test.mjs`, `match.test.mjs` ; `deno test --allow-env --allow-read supabase/functions/noel-radar/index.test.ts` ; `deno test --allow-env server/jobs.test.ts` ; `deno test --allow-env --allow-read supabase/functions/noel-radar/selftest.test.ts supabase/functions/noel-refresh/save.test.ts`; `node supabase/functions/noel-radar/observe.test.mjs`, `noel-refresh/schedule.test.mjs`, `source-alerts.test.mjs`
- Ouvrir `site/index.html` avec Playwright en simulant les appels `noel_get`, `noel-preview` et `noel-refresh` (aucune base réelle nécessaire),
  contrôler le rendu à 390 px de large en clair et en sombre, sans défilement horizontal ni erreur de console.
