# Extension « Liste de Noël : ajouter ce produit »

Bouton de navigateur qui ajoute le produit affiché sur n'importe quel site à ta liste de Noël. Réservée au propriétaire : elle utilise ton code propriétaire. La famille n'en a pas besoin.

Manifest V3, sans dépendance ni étape de compilation. Un même dossier sert à Firefox, Chrome/Edge et Safari.

## Fonctionnement

1. Tu ouvres une page produit et tu cliques sur l'icône (ou `Alt+Maj+N`).
2. L'extension lit la page affichée, **uniquement à ce moment-là** (permission `activeTab`) : nom, photo, prix, code-barres, par ordre de priorité JSON-LD, microdonnées, Open Graph, titre de la page.
3. Tu corriges si besoin (nom, prix, précision, « Envie forte »), puis « Ajouter à la liste ». Elle appelle `noel_add`, la même fonction que le site.
4. Option « Chercher aussi chez d'autres marchands » : appelle `noel-preview` (2 recherches SerpAPI sur ~250 par mois, comme l'ajout depuis le site). **Décochée par défaut** ; le choix est mémorisé. Sans cette option, la fiche contient l'offre de la page seulement ; « Autres marchands » reste disponible depuis la fiche sur le site.

Règles reprises du site (CLAUDE.md, règle 4) :
- places de marché, sites d'occasion et comparateurs : jamais enregistrés comme offre (listes `MARKET` / `COMPARATOR` de `lib.js`) ; sur ces pages, la recherche est imposée ;
- l'offre lue sur la page est enregistrée **« non vérifiée »**, avec la date du jour ; la relecture serveur (`noel-refresh`) pourra la confirmer ;
- offre enregistrée uniquement si l'adresse est en https et le prix en euros (un prix en autre devise n'est pas repris : à saisir en euros) ;
- un cadeau sans prix est refusé, comme sur le site ;
- alerte de doublon : même adresse, ou nom très proche avec les mêmes chiffres.

L'extension ne lit ni ne montre jamais les réservations (il n'y en a plus de toute façon) et ne contient aucun code ni clé : l'adresse du site et le code sont saisis dans les réglages. La clé publique « anon » est lue dans la page d'accueil du site, où le serveur l'injecte.

## Installation

Au premier lancement, ouvre les réglages de l'extension : adresse de ta liste + code propriétaire (ou ton lien de gestion `…/#c=…`, le code en est extrait). Le navigateur te demande l'autorisation de joindre **ton site uniquement**. Le code est gardé dans le stockage local de l'extension, sur cet appareil.

### Firefox
- Test : `about:debugging#/runtime/this-firefox` → « Charger un module complémentaire temporaire » → choisir `manifest.json`. Il disparaît à la fermeture de Firefox.
- Permanent : Firefox n'accepte durablement qu'une extension signée. Signature gratuite en distribution « non listée » sur addons.mozilla.org (`npx web-ext sign --channel=unlisted` avec une clé API AMO).

### Chrome, Edge, Brave
`chrome://extensions` → activer le « Mode développeur » → « Charger l'extension non empaquetée » → choisir ce dossier. Chrome peut afficher un avertissement au démarrage pour les extensions en mode développeur.

### Safari (macOS)
Safari ne charge pas un dossier directement : il faut Xcode (gratuit), puis :

```
xcrun safari-web-extension-converter extension/ --project-location ~/Developer/noel-safari
```

Ouvrir le projet généré dans Xcode, le lancer, puis activer l'extension dans Safari → Réglages → Extensions, et lui accorder l'accès à ton site et aux sites que tu consultes. Sans compte développeur payant, Safari demande de réactiver les extensions non signées à chaque session (menu Développement → « Autoriser les extensions non signées »). La durée de validité avec un compte gratuit n'a pas été vérifiée ici.

## Limites connues

- **Testée seulement dans Chromium** (Playwright, faux site et fausses pages : `node extension/test/lib.test.mjs` pour la logique ; le test de navigateur n'est pas dans le dépôt). Firefox et Safari n'ont pas été essayés : les API utilisées (`scripting`, `storage`, `permissions`, `activeTab`) y existent, mais des différences de comportement sont possibles, surtout sur Safari.
- La lecture dépend de ce que la page publie. Les sites sans données structurées (ou qui affichent le prix après coup par JavaScript) donnent un prix vide ou faux : il est affiché comme « à vérifier » et modifiable.
- Plusieurs variantes sur une page : l'extension prend la moins chère de celles en stock, qui n'est pas forcément celle affichée à l'écran.
- Les pages internes du navigateur (`about:`, `chrome:`, magasins d'extensions) ne sont pas lisibles : l'extension s'ouvre quand même, avec les champs à remplir à la main.
- Le formulaire ne propose pas la catégorie ni la version souhaitée : à régler ensuite avec « Modifier » sur le site.
- Pas de version mobile : les extensions n'existent pas sur Chrome Android, et sur iPhone elles demandent une app complète.

## Maintenance

- `MARKET` et `COMPARATOR` dans `lib.js` sont copiées de `supabase/functions/noel-preview/offers.js` : si on en modifie une, modifier l'autre.
- `offerOut` (`lib.js`) reprend la forme d'offre de `site/index.html` : à garder identique si ce format change.
- Les appels (`noel_add`, `noel_get`, `noel-preview`) suivent `site/index.html` ; un changement de leurs paramètres demande de mettre `popup.js` à jour.
- Test : `node extension/test/lib.test.mjs`.
