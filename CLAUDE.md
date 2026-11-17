# Liste de Noël famille : consignes pour l'IA

Site d'une seule page, servi par un petit serveur Deno avec une base PostgreSQL, le tout sur le VPS de Dorian (`https://noel.dorianlab.fr`, Coolify). Supabase n'est plus utilisé en production depuis la bascule (novembre 2026).
Depuis le 17 novembre, la réservation est RÉACTIVÉE en version ultra-simplifiée (1 clic, anonyme, sans prénom) :
- Famille : ouvre le lien `#c=<code_famille>` qui est mémorisé à vie sur son appareil (`localStorage`). Chaque appareil génère un jeton aléatoire unique (`ftok`). Un bouton « Je le prends » réserve le cadeau en 1 clic via `noel_claim(code, id, ftok)` sans demander de prénom. Sur son propre appareil, un bouton « Annuler » (`noel_unclaim`) permet de se rétracter. Pour les autres membres de la famille, le cadeau est marqué « Déjà pris ».
- Public sans code : ouvre `noel.dorianlab.fr` sans `#c=`, la page appelle `noel_public()` (lecture seule stricte : aucun état « Déjà pris » n'est visible ni renvoyé).
- Propriétaire : page cachée `site/gestion.html` (redirige vers `./#gestion`, saisie du code propriétaire), ou lien `#c=<code propriétaire>`. Un flag `is_owner` est gardé dans `localStorage` pour empêcher l'appareil du propriétaire d'enregistrer accidentellement un code famille. La base PostgreSQL ne renvoie JAMAIS les données de réservation au propriétaire (règle 1). Dans « Réglages de la liste », le propriétaire peut définir/renouveler le code famille et copier le message d'invitation prêt à l'envoi.
Public : famille, y compris peu à l'aise avec le numérique, surtout sur téléphone. Langue : français.

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
  la tâche planifiée Coolify (toutes les 2 h, 3 fiches au plus, les moins récemment lues ; en-tête `x-cron-secret`) et par le bouton « Actualiser » du propriétaire.
  Elle écrit le prix, l'état de vérification, le stock et l'historique (`noel_prices`).
- `supabase/functions/noel-preview/{parse.js,offers.js,verify.js,net.ts}` sont copiés à l'identique dans `noel-refresh/`
  (`node supabase/functions/shared.test.mjs` le vérifie). Après une modification, recopier puis redéployer les deux fonctions.
  Tests : `parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs`, `trust.test.mjs` (dans `noel-preview/`) et `shared.test.mjs`.
  `trust.js` (sécurité des marchands) n'existe que dans `noel-preview/` ; `noel-refresh` conserve le champ `trust` des offres sans le recalculer.
- `extension/` : extension de navigateur (Manifest V3, Firefox / Chrome / Safari) qui ajoute à la liste le produit de la page affichée (`noel_add`, et `noel-preview` seulement si la case est cochée : 2 recherches SerpAPI).
  Propriétaire seulement ; aucun code ni clé dans le dossier. Listes `MARKET` / `COMPARATOR` de `extension/lib.js` copiées de `offers.js` (à garder identiques). Détails et limites : `extension/README.md`. Test : `node extension/test/lib.test.mjs`. Non publiée (seul `site/` l'est).
- `site/icon-*.png` : icônes d'écran d'accueil. Le manifeste est créé par la page elle-même (il contient le lien de la liste).
- `server/main.ts`, `Dockerfile`, `docker-compose.coolify.yml` : serveur Deno (page + fonctions `noel-*` + relais PostgREST), PostgREST et service `backup`. `deploy/` : scripts de base, `RUNBOOK.md`.
- `redirect/` + `.github/workflows/pages.yml` : GitHub Pages ne publie plus qu'une redirection vers `noel.dorianlab.fr` (le `#c=` est conservé).

## Publier
Le site est déployé par Coolify depuis ce dépôt (projet `noel`, ressource `noel-app`) : fusionner sur la branche suivie, puis « Redeploy » à la main dans Coolify (pas de webhook), puis vérifier `https://noel.dorianlab.fr/healthz`. Un push sur `main` ne publie que la page de redirection sur GitHub Pages. Documentation d'exploitation : dossier `vps-infra` de Dorian (`JOURNAL.md`, `ARCHITECTURE.md`).

## Base et fonctions (VPS)
La base est `noel-db` (PostgreSQL 17, ressource Coolify privée, aucun port publié). Changer la base : écrire une migration SQL, l'appliquer par SSH dans le conteneur (`psql`) en tant que `noel_owner`, puis mettre à jour `supabase/schema.sql`. Les fonctions `noel-preview` et `noel-refresh` tournent dans le service `app` (code du dossier `supabase/functions/`). L'ancien projet Supabase `pegojglksepcfvispcrs` n'est plus la production (gardé quelques semaines, puis en pause) : ne plus y déployer. Les anciennes instructions ci-dessous (`apply_migration`, `deploy_edge_function`, `verify_jwt`) sont obsolètes.

Ancienne description (historique) :
Changer une fonction : `deploy_edge_function` (`noel-preview` : `index.ts`, `discover.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ;
`noel-refresh` : `index.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ; `verify_jwt: true` pour les deux), puis garder le dossier du
dépôt identique à ce qui est déployé. Le relevé toutes les 2 h est maintenant une tâche planifiée Coolify (`price-refresh`, service `app`) ; le bloc `pg_cron` de `schema.sql` est conservé pour l'historique et n'est pas appliqué sur le VPS.

Le secret `SERPAPI_KEY` est une variable de la ressource Coolify (vide pour l'instant : la recherche de produit est désactivée ; jamais dans le dépôt). Règle : on reste sur l'offre gratuite (environ 250 recherches
par mois). Seul l'ajout d'une fiche, le choix d'une autre fiche proposée et le bouton « Autres marchands » (avec confirmation) consomment
des recherches. L'actualisation des prix (automatique ou bouton) lit les pages des marchands directement et ne consomme rien.
Ne jamais ajouter de relevé automatique qui appelle SerpAPI.

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
Refonte du 14 novembre (direction « Catalogue », `site/index.html` seulement : aucune base ni fonction serveur touchée). Polices : Bebas Neue (titres, prix, noms) et Figtree
(texte), chargées depuis Google Fonts. Palette : violet (accent) et rouge (action), thème SOMBRE PAR DÉFAUT (`<html data-theme="dark">`) ; « Affichage » propose sombre, clair
ou automatique (`localStorage` `theme`), et le texte agrandi (`size`). Interface sobre, gros boutons, mobile en priorité, texte français simple.
- En-tête : compte à rebours, bouton « Affichage », titre et phrase d'explication dans un bloc centré.
- Vue famille (`famHtml`, `famCard`) : deux sections, « Mes préférés » (cadeaux marqués « Envie forte », sans limite) puis « Autres idées ». Aucun onglet, aucune recherche,
  aucun tri ni filtre pour la famille (les réglages `cat`, `bud`, `sort`, `om` gardés sur l'appareil sont ignorés). Grille de 2 colonnes (3 dès 760 px). Carte : photo carrée
  (`object-fit:contain`), nom souligné, meilleur prix, marchand et « prix vérifié » / « non vérifié », précision et « Version : … », bouton « Voir les prix ». Un cadeau sans prix
  affiche « Prix à confirmer » ; l'ajout d'un cadeau sans prix est refusé.
- Fiche détaillée (`#sheet`, `openSheet`, `refreshSheet`) : s'ouvre au toucher de la photo, du nom ou du bouton. Elle contient la carte complète `giftHtml(g)` (meilleur prix,
  « Voir l'offre », puis « Tous les prix et détails » replié : liste de prix, historique, comparateurs). Elle est redessinée à chaque mise à jour (`render()`), sauf pendant
  une saisie (`tick`). Fermeture : bouton « Fermer », fond, touche Échap. La bannière « Prix en baisse » concerne tous les cadeaux.
- Propriétaire : liste en une colonne avec `giftHtml` (même carte détaillée), formulaire d'ajout en haut, recherche et « Trier et filtrer » conservés, « Inviter la famille »,
  « Sites en avant » et « Marchands écartés » dans le bloc replié « Réglages de la liste » (`#settings`). Le message d'invitation ne parle plus de réservation.
- L'état ouvert / fermé des blocs repliés est gardé dans `openK` (attribut `data-k`, fonction `dk()`), sinon la mise à jour toutes les 20 s les refermerait.
- Refonte de la partie propriétaire (14 novembre, `site/index.html` seulement, règles CSS sous `body[data-role="owner"]`, la vue famille n'est pas touchée) : page large (1120 px) sur ordinateur,
  en-tête compact, barre d'ajout en une ligne (`#addForm`, aperçu à gauche, précision / « Envie forte » / « Corriger le nom ou le prix » / « Ajouter à la liste » à droite), barre d'outils
  « Mes idées N » + recherche + « Trier et filtrer » + « Actualiser tous les prix » sur une ligne, liste en grille (3 colonnes dès 960 px, 2 dès 640 px, 1 sur téléphone), fiche en modification
  sur toute la largeur et en deux colonnes dès 860 px, réglages côte à côte. Les identifiants des éléments et la logique d'ajout sont inchangés. Le nombre affiché est le total des idées (aucun lien avec les réservations, règle 1).
- Les icônes d'écran d'accueil (`icon-*.png`) sont restées vertes.

## Limites connues (à ne pas cacher à l'utilisateur)
- Amazon, Fnac, Darty, Sony, LEGO, Boulanger ne se laissent pas lire : leurs offres restent « non vérifiées » (dernier prix Google connu).
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

## Vérifier avant de pousser
- `node supabase/functions/noel-preview/parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs`, `trust.test.mjs` et `node supabase/functions/shared.test.mjs`
- Ouvrir `site/index.html` avec Playwright en simulant les appels `noel_get`, `noel-preview` et `noel-refresh` (aucune base réelle nécessaire),
  contrôler le rendu à 390 px de large en clair et en sombre, sans défilement horizontal ni erreur de console.
