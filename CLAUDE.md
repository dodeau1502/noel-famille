# Liste de Noël famille : consignes pour l'IA

Site statique (une seule page) + base Supabase. Le propriétaire (Dorian) y met ses idées de cadeaux, ses proches
réservent ce qu'ils offrent, et le propriétaire ne voit jamais les réservations. Public : famille, y compris peu à l'aise
avec le numérique, surtout sur téléphone. Langue : français.

## Structure
- `site/index.html` : toute la page (HTML, CSS, JS, sans build). Seul ce dossier est publié.
- `supabase/schema.sql` : état actuel complet de la base. À mettre à jour après chaque migration.
- `supabase/functions/noel-preview/` : fonction serveur qui lit un lien de magasin (photo, titre, prix).
  `parse.js` est testé par `node parse.test.mjs`.
- `.github/workflows/pages.yml` : publie `site/` sur GitHub Pages à chaque push sur `main`.

## Publier
Pousser sur `main` suffit. Rien d'autre. Le site se met à jour en 1 à 2 minutes.

## Supabase
Projet `pegojglksepcfvispcrs` (région eu-west-3). Changer la base : `apply_migration`, puis mettre à jour `supabase/schema.sql`.
Changer la fonction : `deploy_edge_function` (nom `noel-preview`, `verify_jwt: true`, fichiers `index.ts` et `parse.js`), puis
garder le dossier du dépôt identique à ce qui est déployé.

## Règles à ne jamais enfreindre
1. Confidentialité : le propriétaire ne reçoit jamais `claimed_by` ni aucune donnée de réservation. Ne pas ajouter de colonne,
   de fonction ou d'affichage qui permette de le déduire (ni compteur de cadeaux pris, ni ordre qui change).
2. Aucun accès direct aux tables depuis l'API publique : garder RLS activé, aucune policy, `revoke all` pour `anon` et
   `authenticated`. Tout passe par les fonctions `noel_*` qui vérifient un code.
3. Ne jamais écrire les codes d'accès (propriétaire ou famille) dans le dépôt, un commit, une issue ou un message de PR.
   Ils ne sont stockés que sous forme d'empreinte en base. La clé « anon » de Supabase dans `index.html` est publique par conception.
4. La fonction `noel-preview` ne doit répondre qu'au code propriétaire et refuser les adresses internes (protection SSRF).
5. Échapper tout texte venant de la base avant de l'insérer dans le HTML (`esc()`), n'accepter que des liens `http(s)`
   et des images `https`.

## Style
Interface sobre, gros boutons, texte lisible à l'écran d'un téléphone, thème clair et sombre via variables CSS.
Texte en français simple, phrases courtes. Garder une seule colonne.

## Vérifier avant de pousser
- `node supabase/functions/noel-preview/parse.test.mjs`
- Ouvrir `site/index.html` avec Playwright en simulant les appels `noel_get` et `noel-preview` (aucune base réelle nécessaire),
  contrôler le rendu à 390 px de large en clair et en sombre, sans défilement horizontal ni erreur de console.
