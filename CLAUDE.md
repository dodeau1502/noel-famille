# Liste de Noël famille : consignes pour l'IA

Site statique (une seule page) + base Supabase. Le propriétaire (Dorian) y met ses idées de cadeaux, ses proches
réservent ce qu'ils offrent, et le propriétaire ne voit jamais les réservations. Public : famille, y compris peu à l'aise
avec le numérique, surtout sur téléphone. Langue : français.

## Structure
- `site/index.html` : toute la page (HTML, CSS, JS, sans build). Seul ce dossier est publié.
- `supabase/schema.sql` : état actuel complet de la base. À mettre à jour après chaque migration.
- `supabase/functions/noel-preview/` : fonction serveur appelée quand le propriétaire tape un lien ou un nom de produit (`discover.ts`).
  Étapes : lecture de la page si c'est un lien (`parse.js` : titre, photo, prix, code-barres, stock) ; Google Shopping (SerpAPI, secret
  `SERPAPI_KEY`) pour repérer la fiche produit exacte (`pickProduct` dans `offers.js`) ; fiche produit Google (`google_immersive_product`)
  pour tous les marchands ; lecture directe des pages des 5 offres les moins chères (`net.ts`, `verify.js`) : chaque offre est
  « vérifiée » (prix confirmé par la page du marchand, avec la date) ou « non vérifiée » (prix Google seulement). Coût : 2 recherches
  SerpAPI par fiche ajoutée (3 avec le code-barres en secours). Le propriétaire peut choisir une autre fiche proposée (`token`, 1 recherche de plus).
- `supabase/functions/noel-refresh/` : relecture GRATUITE des pages des marchands déjà connus (aucune recherche SerpAPI). Appelée par
  le planning de la base (`pg_cron`, toutes les 2 h, 3 fiches au plus, les moins récemment lues) et par le bouton « Actualiser » du propriétaire.
  Elle écrit le prix, l'état de vérification, le stock et l'historique (`noel_prices`).
- `supabase/functions/noel-preview/{parse.js,offers.js,verify.js,net.ts}` sont copiés à l'identique dans `noel-refresh/`
  (`node supabase/functions/shared.test.mjs` le vérifie). Après une modification, recopier puis redéployer les deux fonctions.
  Tests : `parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs` (dans `noel-preview/`) et `shared.test.mjs`.
- `site/icon-*.png` : icônes d'écran d'accueil. Le manifeste est créé par la page elle-même (il contient le lien de la liste).
- `.github/workflows/pages.yml` : publie `site/` sur GitHub Pages à chaque push sur `main`.

## Publier
Pousser sur `main` suffit. Rien d'autre. Le site se met à jour en 1 à 2 minutes.

## Supabase
Projet `pegojglksepcfvispcrs` (région eu-west-3). Changer la base : `apply_migration`, puis mettre à jour `supabase/schema.sql`.
Changer une fonction : `deploy_edge_function` (`noel-preview` : `index.ts`, `discover.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ;
`noel-refresh` : `index.ts`, `net.ts`, `parse.js`, `offers.js`, `verify.js` ; `verify_jwt: true` pour les deux), puis garder le dossier du
dépôt identique à ce qui est déployé. Le planning (`pg_cron`) est décrit en fin de `schema.sql` ; la clé « anon » publique y est remplacée par un repère.

Le secret `SERPAPI_KEY` est stocké côté Supabase (jamais dans le dépôt). Règle : on reste sur l'offre gratuite (environ 250 recherches
par mois). Seul l'ajout d'une fiche, le choix d'une autre fiche proposée et le bouton « Autres marchands » (avec confirmation) consomment
des recherches. L'actualisation des prix (automatique ou bouton) lit les pages des marchands directement et ne consomme rien.
Ne jamais ajouter de relevé automatique qui appelle SerpAPI.

## Base : conventions
- Les fonctions `noel_*` renvoient du jsonb `{"ok":true}` ou `{"error":"denied|throttled|taken|short|same_as_owner|empty"}`,
  elles ne lèvent pas d'exception (sinon l'enregistrement des essais de code ratés serait annulé). La page traduit ces erreurs (`MSG`, `rpc()`).
- Limitation : 15 essais ratés par 10 minutes et par adresse (`noel_attempts`, `noel_role`).
- Fonctions propriétaire : `noel_add`, `noel_remove`, `noel_set_top`, `noel_set_offers`, `noel_set_family_code`.
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

## Règles à ne jamais enfreindre
1. Confidentialité : le propriétaire ne reçoit jamais `claimed_by`, `bought`, `paid` ni aucune donnée de réservation. Ne pas ajouter de colonne,
   de fonction ou d'affichage qui permette de le déduire (ni compteur de cadeaux pris, ni ordre qui change). Le relevé automatique
   (`noel-refresh`) traite toutes les fiches de la même façon : il choisit uniquement d'après `checked_at` et ne lit jamais `noel_claims`
   (sinon les dates de relevé révéleraient quels cadeaux sont pris). L'historique des prix est identique pour tous.
2. Aucun accès direct aux tables depuis l'API publique : garder RLS activé, aucune policy, `revoke all` pour `anon` et
   `authenticated`. Tout passe par les fonctions `noel_*` qui vérifient un code.
3. Ne jamais écrire les codes d'accès (propriétaire ou famille) dans le dépôt, un commit, une issue ou un message de PR.
   Ils ne sont stockés que sous forme d'empreinte en base. La clé « anon » de Supabase dans `index.html` est publique par conception.
4. Les offres affichées doivent correspondre au produit et être fiables (`offers.js`, doublé côté page par `isMarket`) :
   tous les mots-clés et toutes les références chiffrées de la requête présents (un chiffre seul compte), même version
   (pro, max, combo, pack…), neuf uniquement (occasion, reconditionné, `second_hand_condition` écartés), places de marché et
   identifiants de vendeur écartés (Leboncoin, eBay, Vinted, Back Market, Rakuten…), prix suspects écartés (hors 0,6 à 1,8 fois la
   médiane dès 3 prix), comparateurs écartés (idealo, Kelkoo, Dealabs… : ce ne sont pas des marchands), classement par prix +
   livraison quand elle est connue, rupture de stock en dernier. Ne pas assouplir ces règles sans ajouter un test dans `offers.test.mjs` ;
   pour un nouveau site à exclure, l'ajouter aux listes `MARKET` / `COMPARATOR` de `offers.js` (et de sa copie dans `noel-refresh`) et de `index.html`.
   Ne jamais promettre « le meilleur prix absolu » : chaque prix affiche sa source, sa date et son état de vérification. Pas de lien affilié.
5. Les fonctions `noel-preview` et `noel-refresh` ne répondent qu'au code propriétaire (`noel-refresh` accepte aussi le mode planning,
   qui ne renvoie rien de sensible) et refusent les adresses internes à chaque redirection (protection SSRF, `net.ts`).
6. Échapper tout texte venant de la base avant de l'insérer dans le HTML (`esc()`), n'accepter que des liens `http(s)`
   et des images `https`.

## Style
Interface sobre, gros boutons, texte lisible à l'écran d'un téléphone, thème clair et sombre via variables CSS.
Texte en français simple, phrases courtes. Garder une seule colonne.

## Limites connues (à ne pas cacher à l'utilisateur)
- Amazon, Fnac, Darty, Sony, LEGO, Boulanger ne se laissent pas lire : leurs offres restent « non vérifiées » (dernier prix Google connu).
- Une recherche par nom seul (sans lien) peut choisir la mauvaise fiche : la page propose alors les autres fiches. Le lien du marchand marche mieux.
- Pas de seconde source de prix (Kelkoo/idealo via Apify) ni de copie locale de la photo du marchand ; pas de test quotidien automatique.
- Les formats d'URL de recherche d'idealo et du Dénicheur n'ont pas pu être testés depuis l'environnement de développement (idealo refusé,
  robots.txt du Dénicheur interdit la lecture automatique de ses recherches) : à contrôler à la main sur téléphone, avec et sans code-barres.
- Journal de diagnostic : `noel-preview` écrit une ligne `noel-diag` par recherche (marchands renvoyés par Google, prix, raison de
  conservation ou d'écart : « titre différent », « comparateur », « place de marché… », « occasion »). Ni clé ni code. À lire dans les
  journaux de la fonction ; à retirer une fois le filtrage réglé.
- Pas de lecture des prix d'idealo (point d'accès non documenté, non vérifiable) : à ne pas ajouter sans échantillon réel de réponse et
  sans accord explicite du propriétaire sur la règle 4.

## Vérifier avant de pousser
- `node supabase/functions/noel-preview/parse.test.mjs`, `offers.test.mjs`, `verify.test.mjs` et `node supabase/functions/shared.test.mjs`
- Ouvrir `site/index.html` avec Playwright en simulant les appels `noel_get`, `noel-preview` et `noel-refresh` (aucune base réelle nécessaire),
  contrôler le rendu à 390 px de large en clair et en sombre, sans défilement horizontal ni erreur de console.
